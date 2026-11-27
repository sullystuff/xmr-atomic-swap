/** Offers (with the update-cost panel), Inventory and Rebalancing. */
import { useId, useState } from 'react';
import { MARKET_CHAIN } from '@xmrswap/protocol';
import type { AssetId, OfferView, RebalanceResponse, RefillView, VenueId } from '@xmrswap/protocol/daemon-api';
import type { OfferViewX, RefillViewX } from '../api/extensions.js';
import { useAction, useClient, useLive, useQuery } from '../api/hooks.js';
import { capacityLimitText, capsState } from '../lib/amendment.js';
import { CapsPanel } from '../ui/amendment.js';
import { ASSETS, DIRECTION_LABEL, MODE_OPTIONS, VENUE_LABEL, chainLabel } from '../lib/config/schema.js';
import { patchConfig } from '../lib/config/patch.js';
import { getPath, isTable, setPath, type Toml } from '../lib/config/toml.js';
import { allowlisted, withdrawKeyProblems, withdrawKeys } from '../lib/config/validate.js';
import { BASE_FEE_LAMPORTS, costBasis, estimateCost } from '../lib/cost.js';
import { ASSET_DECIMALS, ASSET_LABEL, ASSET_UNIT, MARKET_LABEL, MARKET_ORDER, fmtAsset, fmtDuration, fmtMarketAmount, fmtPct, fmtTime, fmtUnits, fmtUsd, fmtXmr, parseUnits } from '../lib/format.js';
import { CostPanel } from '../ui/cost-panel.js';
import { SwapLink } from '../ui/domain.js';
import { Async, Badge, Button, Card, ConfirmButton, Countdown, Empty, Id, Meter, Notice, PageHead, Stat, Time } from '../ui/kit.js';

// ------------------------------------------------------------------ offers

const MODE_LABEL = { auto: 'Auto-accept', window: 'Approval window', advance: 'Approved in advance' } as const;

/** Why an enabled-in-the-file offer has no price, in the daemon's words turned plain. */
export function noPriceText(reason: string | undefined): string {
  const m = /averaging window is not filled yet \((\d+) of (\d+) s\)/.exec(reason ?? '');
  if (m) return `No price yet: the pool’s averaging window is still filling (${m[1]} of ${m[2]} s). Quoting starts when it is full.`;
  return `No price right now${reason ? `: ${reason}` : ''}.`;
}
const SOURCE_NAME: Record<string, string> = { coingecko: 'CoinGecko', coinmarketcap: 'CoinMarketCap', wxmr_pool: 'wXMR pool', wxmr_pool_sol: 'wXMR pool (SOL-quoted)' };
export const sourceLabel = (s: string): string => SOURCE_NAME[s] ?? s;

/** Which source is pricing an offer right now, against what the file chose. */
export function PricedBy({ o }: { o: OfferViewX }) {
  if (o.source === undefined) return <span className="muted">not reported</span>;
  const wanted = o.enabled || o.price_tiers.length > 0 || (o.disabled_reason !== undefined && !/switched off/i.test(o.disabled_reason));
  if (!wanted) return <span className="muted">not offered</span>;
  if (o.priced_by === null || o.priced_by === undefined) {
    return (
      <span data-testid="no-price">
        <Badge tone="warn">No price</Badge>
        <span className="msg warning" style={{ display: 'block' }}>
          {noPriceText(o.disabled_reason)}
        </span>
      </span>
    );
  }
  const fallback = o.priced_by !== o.source;
  return (
    <span>
      {sourceLabel(o.priced_by)} {fallback ? <Badge tone="warn">Fallback in use</Badge> : null}
      <span className="muted" style={{ display: 'block' }}>
        {fallback ? `primary ${sourceLabel(o.source)} is unavailable` : (o.fallbacks ?? []).length > 0 ? `then ${(o.fallbacks ?? []).map(sourceLabel).join(', ')}` : 'no fallback'}
        {' · '}
        {o.cross_check ? `checked against ${sourceLabel(o.cross_check)}` : 'no cross-check'}
        {o.price_unit === 'asset' ? ' · priced in SOL directly, no USD figure' : ''}
      </span>
    </span>
  );
}

function OfferStatus({ o }: { o: OfferViewX }) {
  if (o.live) return <Badge tone="ok">Live</Badge>;
  if (o.source !== undefined && o.priced_by === null && o.disabled_reason !== undefined && /averaging window|no price/i.test(o.disabled_reason)) return <Badge tone="warn">Waiting for a price</Badge>;
  if (o.enabled) return <Badge tone="info">{o.disabled_reason?.startsWith('Paused') ? 'Paused' : 'Dry run'}</Badge>;
  return <Badge>Off</Badge>;
}

export function OffersPage() {
  const { status } = useLive();
  const offers = useQuery('offers', undefined, ['offers', 'status']);
  const fees = useQuery('fees', undefined, ['offers']);
  const config = useQuery('configGet', undefined, ['offers']);
  return (
    <>
      <PageHead title="Offers" actions={<a href="#/config">Edit offer settings</a>}>
        What each market and direction publishes right now, or would publish in dry run. A taker can lock against a live offer at once, so check these against your intent.
      </PageHead>
      <div className="stack">
        <Card title="Protocol beta caps" note="What the protocol allows to be open, per asset. Your offers cannot fill beyond it." flush>
          {status ? <CapsPanel caps={status.caps} /> : <Empty title="Waiting for the daemon" />}
        </Card>
        <Card title="Offers by market and direction" flush>
          <Async query={offers} what="the offers">
            {(r) => {
              const sorted = [...r.offers].sort((a, b) => MARKET_ORDER.indexOf(a.market) - MARKET_ORDER.indexOf(b.market) || (a.direction === 'sell_xmr' ? -1 : 1));
              return (
                <div className="table-wrap">
                  <table className="tbl" aria-label="Offers">
                    <thead>
                      <tr>
                        <th scope="col">Market</th>
                        <th scope="col">Status</th>
                        <th scope="col">Priced by, now</th>
                        <th scope="col">Price per XMR</th>
                        <th scope="col" className="num">
                          Size
                        </th>
                        <th scope="col" className="num">
                          Capacity
                        </th>
                        <th scope="col">Key pool</th>
                        <th scope="col">Terms</th>
                        <th scope="col">Refreshed</th>
                      </tr>
                    </thead>
                    <tbody>
                      {sorted.map((o) => (
                        <tr key={`${o.market}.${o.direction}`}>
                          <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text)', fontSize: 'inherit' }}>
                            {MARKET_LABEL[o.market]}
                            <div className="muted" style={{ fontWeight: 400 }}>
                              {DIRECTION_LABEL[o.direction]} · {chainLabel(MARKET_CHAIN[o.market])}
                            </div>
                          </th>
                          <td>
                            <OfferStatus o={o} />
                            {o.disabled_reason ? <div className="muted">{o.disabled_reason}</div> : null}
                          </td>
                          <td>
                            <PricedBy o={o} />
                          </td>
                          <td>
                            {o.price_tiers.length === 0 ? (
                              <span className="muted">none</span>
                            ) : (
                              <>
                                {o.price_tiers.map((t, i) => (
                                  <div key={t.above_xmr} className="mono">
                                    {fmtMarketAmount(o.market, t.price, 4)}
                                    {i > 0 ? <span className="muted"> above {fmtUnits(t.above_xmr, 12, 2)} XMR</span> : null}
                                  </div>
                                ))}
                                <div className="muted">
                                  reference {o.reference_price ? fmtMarketAmount(o.market, o.reference_price, 4) : 'n/a'} {o.direction === 'sell_xmr' ? '+' : '−'} {fmtPct(o.deviation_pct, 2)}
                                </div>
                              </>
                            )}
                          </td>
                          <td className="num">
                            {fmtUnits(o.min_xmr, 12, 2)} to {fmtUnits(o.max_xmr, 12, 2)}
                          </td>
                          <td className="num">
                            {o.enabled ? fmtXmr(o.capacity_xmr, 2) : <span className="muted">none</span>}
                            {o.enabled ? (
                              <div className={o.capacity_limit === 'max_swap' || o.capacity_limit === 'max_open' ? 'msg warning' : 'muted'} data-testid="capacity-limit" style={{ whiteSpace: 'normal', minWidth: '16ch' }}>
                                {capacityLimitText(o.capacity_limit, status ? status.caps.filter((c) => c.market === o.market).map(capsState)[0] : undefined, o.market)}
                              </div>
                            ) : null}
                          </td>
                          <td>
                            {o.key_pool ? (
                              <>
                                <span className="mono">
                                  {o.key_pool.available} of {o.key_pool.size}
                                </span>{' '}
                                {o.key_pool.available * 4 <= o.key_pool.size ? <Badge tone="warn">Low</Badge> : null}
                              </>
                            ) : (
                              <span className="muted">not used</span>
                            )}
                          </td>
                          <td>
                            {MODE_LABEL[o.terms.approval_mode]}
                            {o.terms.approval_mode !== 'auto' || MARKET_CHAIN[o.market] === 'ethereum' ? ` · window ${o.terms.approval_window_secs} s` : ''}
                            <div className="muted">
                              claim delay {Math.round(o.terms.claim_delay_secs / 60)} min · deposit {fmtPct(o.terms.deposit_bps / 100, 2)} · depth up to {Math.max(...o.terms.depth_tiers.map((t) => t.depth), 0)} · {o.terms.freeze_window_secs > 0 ? `freeze window ${fmtDuration(o.terms.freeze_window_secs)}` : 'no watcher accepted'}
                            </div>
                          </td>
                          <td>
                            {o.updated_at ? (
                              <>
                                <Time at={o.updated_at} />
                                <div className="muted">
                                  lapses in <Countdown to={o.valid_until} chain={MARKET_CHAIN[o.market]} urgentBelow={10} soonBelow={20} passed="lapsed" />
                                </div>
                              </>
                            ) : (
                              <span className="muted">not published</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              );
            }}
          </Async>
        </Card>

        <Card title="Update cost" note="What refreshing offers on Solana costs per day. Change the interval or the priority fee under Configuration to see the estimate move before you save.">
          <Async query={offers} what="the update cost">
            {(r) => {
              const est = r.update_cost;
              if (!est) return <Empty title="No estimate">The daemon reported no update cost.</Empty>;
              const parsed = config.data?.parsed;
              const num = (p: string): number | undefined => {
                const v = parsed ? getPath(parsed, p) : undefined;
                return typeof v === 'number' ? v : undefined;
              };
              const trigger = num('offers.price_move_trigger_pct');
              // The daemon's own SOL price and compute-unit figure when it sends them.
              const basis = costBasis(fees.data, r);
              const solUsd = basis.solUsd;
              const valid = r.offers.filter((o) => o.enabled).map((o) => (parsed && typeof getPath(parsed, `markets.${o.market}.${o.direction}.offer_valid_seconds`) === 'number' ? (getPath(parsed, `markets.${o.market}.${o.direction}.offer_valid_seconds`) as number) : 60));
              const per = BigInt(est.lamports_per_update);
              const cost = estimateCost({
                intervalSecs: est.interval_secs,
                priorityMicroLamports: 0,
                perUpdateLamports: per,
                moveTriggerPct: trigger,
                minRefreshSecs: num('offers.min_refresh_interval_seconds'),
                offerValidSecs: valid.length > 0 ? Math.min(...valid) : undefined,
                expectedTriggeredPerDay: est.triggered_per_day.expected,
                solUsd,
              });
              return (
                <>
                  <CostPanel cost={cost} intervalSecs={est.interval_secs} solUsd={solUsd} fees={fees.data} offers={r} />
                  <p className="muted" style={{ marginTop: 8 }}>
                    Refreshing every {est.interval_secs} s{per > BASE_FEE_LAMPORTS ? ` with a priority fee of ${(per - BASE_FEE_LAMPORTS).toString()} lamports per update` : ' at the base fee'}.{' '}
                    <span data-testid="cost-basis">
                      {solUsd === null ? 'No SOL price is available, so no dollar figure is shown.' : `Priced at ${fmtUsd(solUsd)} per SOL${basis.fromDaemon ? ', the daemon’s own price' : ', implied by its last estimate'}`}
                      {solUsd === null ? '' : `; an update is charged at ${basis.cuLimit.toLocaleString('en-US')} compute units.`}
                    </span>
                  </p>
                </>
              );
            }}
          </Async>
        </Card>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ inventory

export function InventoryPage() {
  const client = useClient();
  const inv = useQuery('inventory', undefined, ['swaps']);
  const { busy, run } = useAction();
  return (
    <>
      <PageHead title="Inventory">
        XMR is pre-split into outputs sized to the offer ladder, because a spent output’s change is locked for 10 blocks (about 20 minutes): one output funds one swap at a time. Capacity counts unlocked outputs, never the balance.
      </PageHead>
      <Async query={inv} what="the inventory">
        {(r) => {
          const missing = r.ladder.reduce((n, l) => n + Math.max(0, l.target_count - l.unlocked_count - l.locked_count), 0);
          return (
            <div className="stack">
              <dl className="stats">
                <Stat label="Capacity (unlocked outputs)" value={fmtXmr(r.capacity_xmr, 2)} hint="what offers can fill right now" />
                <Stat label="Balance" value={fmtXmr(r.xmr.balance, 2)} hint={`${fmtXmr(r.xmr.unlocked, 2)} unlocked`} />
                <Stat label="Reserve" value={fmtXmr(r.xmr.reserve, 2)} hint="never offered" />
                <Stat label="In flight" value={fmtXmr(r.xmr.in_flight, 2)} hint="locked in open swaps" />
              </dl>
              <div className="cols-2">
                <Card
                  title="Output ladder"
                  flush
                  actions={
                    <ConfirmButton
                      label="Split to the ladder"
                      small
                      disabled={missing === 0}
                      busy={busy === 'split'}
                      onConfirm={() =>
                        void run('split', () => client.call('inventorySplit', { body: {} }), (res) => (res.created === 0 ? 'The ladder is already full.' : `Created ${res.created} output${res.created === 1 ? '' : 's'} in ${res.txids.length} transaction${res.txids.length === 1 ? '' : 's'}, spendable after 10 blocks.`)).then(inv.reload)
                      }
                    >
                      Split unlocked XMR into the {missing === 1 ? 'one output' : `${missing} outputs`} the ladder is missing (up to 15 per transaction). New outputs are locked for 10 blocks, about 20 minutes.
                    </ConfirmButton>
                  }
                >
                  {r.ladder.length === 0 ? (
                    <Empty title="No ladder configured">Set the output ladder under Configuration, Liquidity.</Empty>
                  ) : (
                    <table className="tbl" aria-label="Output ladder">
                      <thead>
                        <tr>
                          <th scope="col">Size</th>
                          <th scope="col" className="num">
                            Target
                          </th>
                          <th scope="col" className="num">
                            Unlocked
                          </th>
                          <th scope="col" className="num">
                            Locked
                          </th>
                          <th scope="col" className="num">
                            Missing
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.ladder.map((l) => {
                          const miss = Math.max(0, l.target_count - l.unlocked_count - l.locked_count);
                          return (
                            <tr key={l.size_xmr}>
                              <th scope="row">{fmtXmr(l.size_xmr, 2)}</th>
                              <td className="num">{l.target_count}</td>
                              <td className="num">{l.unlocked_count}</td>
                              <td className="num">{l.locked_count}</td>
                              <td className="num">{miss > 0 ? <Badge tone="warn">{miss}</Badge> : 0}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </Card>
                <Card title="Paying balances" note="Committed to buy-XMR offers, up to each cap." flush>
                  <table className="tbl" aria-label="Paying balances">
                    <thead>
                      <tr>
                        <th scope="col">Asset</th>
                        <th scope="col" className="num">
                          Balance
                        </th>
                        <th scope="col" className="num">
                          Cap
                        </th>
                        <th scope="col" className="num">
                          In escrow
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.paying.map((p) => (
                        <tr key={p.asset}>
                          <th scope="row">{ASSET_LABEL[p.asset]}</th>
                          <td className="num">{fmtAsset(p.asset, p.balance)}</td>
                          <td className="num">{p.cap === null ? <span className="muted">no cap</span> : fmtAsset(p.asset, p.cap)}</td>
                          <td className="num">{fmtAsset(p.asset, p.escrowed)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Card>
              </div>
              <Card title="Outputs" note={`${r.outputs.length} outputs in the inventory wallet`} flush>
                {r.outputs.length === 0 ? (
                  <Empty title="No outputs">Fund the inventory wallet, then split to the ladder.</Empty>
                ) : (
                  <div className="table-wrap" style={{ maxHeight: 360, overflowY: 'auto' }}>
                    <table className="tbl" aria-label="Outputs">
                      <thead>
                        <tr>
                          <th scope="col">Key image</th>
                          <th scope="col" className="num">
                            Amount
                          </th>
                          <th scope="col">Spendable</th>
                          <th scope="col">Reserved for</th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.outputs.map((o) => (
                          <tr key={o.key_image}>
                            <td>
                              <Id value={o.key_image} />
                            </td>
                            <td className="num">{fmtXmr(o.amount, 4)}</td>
                            <td>{o.unlocked ? <Badge tone="ok">Unlocked</Badge> : <Badge tone="info">{o.blocks_to_unlock} blocks to unlock</Badge>}</td>
                            <td>{o.reserved_for ? <SwapLink swapRef={o.reserved_for} /> : o.frozen ? <span className="muted">frozen</span> : <span className="muted">free</span>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}

// ------------------------------------------------------------------ rebalancing

const REFILL_STATE: Record<RefillView['state'], { label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'plain' | 'accent' }> = {
  awaiting_approval: { label: 'Awaiting approval', tone: 'accent' },
  pending: { label: 'Pending', tone: 'info' },
  depositing: { label: 'Depositing', tone: 'info' },
  processing: { label: 'Processing', tone: 'info' },
  paying_out: { label: 'Paying out', tone: 'info' },
  done: { label: 'Done', tone: 'ok' },
  held: { label: 'Held by the venue', tone: 'bad' },
  failed: { label: 'Failed', tone: 'bad' },
  refunded: { label: 'Refunded', tone: 'warn' },
  cancelled: { label: 'Cancelled', tone: 'plain' },
};
const MOVING: readonly RefillView['state'][] = ['pending', 'depositing', 'processing', 'paying_out', 'held'];
/** With a venue, or failed and not yet acknowledged (an acknowledged failure is history). */
const inTransit = (x: RefillViewX): boolean => MOVING.includes(x.state) || (x.state === 'failed' && !x.acknowledged);
const modeLabel = (m: string): string => MODE_OPTIONS.find((o) => o.value === m)?.label ?? m;
const venueLabel = (v: RefillView['venue']): string => VENUE_LABEL[v];

function levelStatus(l: RebalanceResponse['levels'][number]): { label: string; tone: 'ok' | 'warn' | 'plain' } {
  const b = BigInt(l.balance);
  if (l.low !== null && b < BigInt(l.low)) return { label: 'Below low: refill', tone: 'warn' };
  if (l.high !== null && b > BigInt(l.high)) return { label: 'Above high: sell down', tone: 'warn' };
  if (l.low === null && l.high === null && l.target === null) return { label: 'No levels set', tone: 'plain' };
  return { label: 'Within levels', tone: 'ok' };
}

function RefillTable({ refills, label, actions }: { refills: RefillViewX[]; label: string; actions?: (r: RefillViewX) => React.ReactNode }) {
  return (
    <div className="table-wrap">
      <table className="tbl" aria-label={label}>
        <thead>
          <tr>
            <th scope="col">Started</th>
            <th scope="col">Venue</th>
            <th scope="col">Route</th>
            <th scope="col" className="num">
              In
            </th>
            <th scope="col" className="num">
              Out
            </th>
            <th scope="col" className="num">
              Cost vs reference
            </th>
            <th scope="col" className="num">
              Fees
            </th>
            <th scope="col">State</th>
            {actions ? (
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {refills.map((r) => (
            <tr key={r.id}>
              <td style={{ whiteSpace: 'nowrap' }}>
                <span title={fmtTime(r.started_at)}>
                  <Time at={r.started_at} />
                </span>
                <div className="muted mono">{r.id}</div>
              </td>
              <td>{venueLabel(r.venue)}</td>
              <td>
                {ASSET_UNIT[r.from]} → {ASSET_UNIT[r.to]}
              </td>
              <td className="num">{fmtAsset(r.from, r.amount_in, 4)}</td>
              <td className="num">{r.amount_out === null ? <span className="muted">pending</span> : fmtAsset(r.to, r.amount_out, 4)}</td>
              <td className="num">{r.cost_pct === null ? <span className="muted">n/a</span> : fmtPct(r.cost_pct, 2)}</td>
              <td className="num">{r.fees_usd === null ? <span className="muted">n/a</span> : fmtUsd(r.fees_usd)}</td>
              <td>
                <Badge tone={REFILL_STATE[r.state].tone}>{REFILL_STATE[r.state].label}</Badge>
                {r.needs_acknowledgement ? <Badge tone="warn">Needs you</Badge> : null}
                {r.acknowledged ? <Badge>Acknowledged</Badge> : null}
                {r.venue === 'wxmr_bridge' && (r.state === 'held' || r.state === 'failed' || r.state === 'refunded' || r.state === 'cancelled') ? (
                  <div className="msg warning" data-testid="wxmr-manual">
                    <b>Manual action:</b> a stopped redemption returns wXMR, not USDC. Any wXMR left in the operator wallet has to be redeemed or sold by hand; the daemon offers no action for it.
                  </div>
                ) : null}
                {r.finished_at ? <div className="muted">took {fmtDuration(r.finished_at - r.started_at)}</div> : null}
                {r.detail ? <div className="muted">{r.detail}</div> : null}
              </td>
              {actions ? <td className="actions">{actions(r)}</td> : null}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function RebalancingPage() {
  const client = useClient();
  const reb = useQuery('rebalance', undefined, ['rebalance']);
  const config = useQuery('configGet');
  const { busy, run } = useAction();
  return (
    <>
      <PageHead title="Rebalancing" actions={<a href="#/config">Edit rebalancing settings</a>}>
        Refills XMR and rebalances SOL, ETH and USDC through the venues you enable. Each venue can run automatically, wait for your approval, or only raise an alert. Adapters hold no keys; nothing here runs in this browser.
      </PageHead>
      <Async query={reb} what="the rebalancer">
        {(r) => {
          const awaiting = r.refills.filter((x) => x.state === 'awaiting_approval');
          const moving = r.refills.filter(inTransit);
          const history = r.refills.filter((x) => !inTransit(x) && x.state !== 'awaiting_approval');
          const cap = r.max_in_transit_usd;
          const parsed = config.data?.parsed;
          const allow = parsed ? getPath(parsed, 'rebalance.allowlist') : undefined;
          const setting = (p: string): unknown => (parsed ? getPath(parsed, p) : undefined);
          const done = history.filter((x) => x.state === 'done' && x.cost_pct !== null);
          const avgCost = done.length > 0 ? done.reduce((s, x) => s + (x.cost_pct ?? 0), 0) / done.length : null;
          const totalFees = done.reduce((s, x) => s + (x.fees_usd ?? 0), 0);
          const approve = (id: string) => run(`approve:${id}`, () => client.call('rebalanceApprove', { params: { id } }), 'Refill approved; it is on its way.').then(reb.reload);
          const ack = (id: string, choice?: 'continue' | 'refund') =>
            run(`ack:${id}:${choice ?? ''}`, () => client.acknowledgeRefill(id, choice), (x) => (choice === 'continue' ? 'Told the venue to continue.' : choice === 'refund' ? 'Asked the venue for a refund.' : `Acknowledged. Refill ${x.id} no longer counts against the in-transit cap.`)).then(reb.reload);
          const cancel = (id: string) => run(`cancel:${id}`, () => client.call('rebalanceCancel', { params: { id } }), 'Refill cancelled.').then(reb.reload);
          return (
            <div className="stack">
              <dl className="stats">
                <Stat label="Mode" value={modeLabel(r.mode)} hint="venues may override it" />
                <Stat
                  label="In transit with third parties"
                  tone={cap !== null && r.in_transit_usd > cap ? 'bad' : undefined}
                  value={<span data-testid="in-transit">{fmtUsd(r.in_transit_usd, 0)}</span>}
                  hint={
                    cap === null ? (
                      'no in-transit cap is set'
                    ) : (
                      <>
                        of a {fmtUsd(cap, 0)} cap
                        <Meter value={r.in_transit_usd} max={cap} label="In-transit value against the cap" />
                      </>
                    )
                  }
                />
                <Stat label="Largest cost allowed" value={typeof setting('rebalance.max_cost_pct') === 'number' ? fmtPct(setting('rebalance.max_cost_pct') as number, 2) : 'not set'} hint="against the reference price" />
                <Stat label="Test transfer" value={typeof setting('rebalance.test_transfer_usd') === 'number' ? fmtUsd(setting('rebalance.test_transfer_usd') as number, 0) : 'not set'} hint="first transfer to a new venue or address" />
              </dl>
              {cap === null ? (
                <Notice tone="warn" title="No in-transit cap.">
                  Nothing bounds the value sitting with third parties at once. Set one under Configuration, Rebalancing.
                </Notice>
              ) : null}

              <Card title="Waiting for your approval" flush>
                {awaiting.length === 0 ? (
                  <Empty title="No refills are waiting">{r.mode === 'approve' ? 'A refill the levels call for appears here first.' : r.mode === 'alert' ? 'In alert-only mode the rebalancer raises alerts and moves nothing by itself.' : 'In automatic mode refills run without asking.'}</Empty>
                ) : (
                  <RefillTable
                    label="Refills awaiting approval"
                    refills={awaiting}
                    actions={(x) => (
                      <span className="row" style={{ justifyContent: 'flex-end' }}>
                        <ConfirmButton label="Approve refill" variant="primary" small busy={busy === `approve:${x.id}`} onConfirm={() => void approve(x.id)}>
                          Send {fmtAsset(x.from, x.amount_in, 4)} through {venueLabel(x.venue)} for {ASSET_UNIT[x.to]}. While it is on its way the venue holds the funds and it counts against the in-transit cap. The payout goes only to an allow-listed address of yours.
                        </ConfirmButton>
                        <Button small busy={busy === `cancel:${x.id}`} onClick={() => void cancel(x.id)}>
                          Decline
                        </Button>
                      </span>
                    )}
                  />
                )}
              </Card>

              <div className="cols-2">
                <Card title="Levels" note="Low, target and high per asset trigger refills." flush>
                  <table className="tbl" aria-label="Levels">
                    <thead>
                      <tr>
                        <th scope="col">Asset</th>
                        <th scope="col" className="num">
                          Balance
                        </th>
                        <th scope="col" className="num">
                          Low
                        </th>
                        <th scope="col" className="num">
                          Target
                        </th>
                        <th scope="col" className="num">
                          High
                        </th>
                        <th scope="col">Status</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.levels.map((l) => {
                        const st = levelStatus(l);
                        const f = (v: string | null) => (v === null ? <span className="muted">unset</span> : fmtUnits(v, ASSET_DECIMALS[l.asset], 2));
                        return (
                          <tr key={l.asset}>
                            <th scope="row">{ASSET_LABEL[l.asset]}</th>
                            <td className="num">{fmtUnits(l.balance, ASSET_DECIMALS[l.asset], 2)}</td>
                            <td className="num">{f(l.low)}</td>
                            <td className="num">{f(l.target)}</td>
                            <td className="num">{f(l.high)}</td>
                            <td>
                              <Badge tone={st.tone}>{st.label}</Badge>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
                <Card
                  title="Venues"
                  note={
                    r.venues.filter((v) => v.enabled).length === 1 && r.venues.some((v) => v.enabled && v.id === 'wxmr_bridge')
                      ? 'Only the wXMR bridge is enabled. That is a complete setup: every refill goes through the bridge, and waits when the bridge is offline or too costly.'
                      : r.venues.every((v) => !v.enabled)
                        ? 'No venue is enabled, so nothing can be refilled from here. One venue is enough.'
                        : 'One venue is enough; several let a refill fall through to the next.'
                  }
                  flush
                >
                  <table className="tbl" aria-label="Venues">
                    <thead>
                      <tr>
                        <th scope="col">Venue</th>
                        <th scope="col">Enabled</th>
                        <th scope="col">Mode</th>
                        <th scope="col">Health</th>
                      </tr>
                    </thead>
                    <tbody>
                      {r.venues.map((v) => (
                        <tr key={v.id}>
                          <th scope="row">{VENUE_LABEL[v.id]}</th>
                          <td>{v.enabled ? <Badge tone="ok">Enabled</Badge> : <Badge>Off</Badge>}</td>
                          <td>{v.enabled ? modeLabel(v.mode) : <span className="muted">n/a</span>}</td>
                          <td>
                            {!v.enabled ? <span className="muted">n/a</span> : v.healthy ? <Badge tone="ok">Healthy</Badge> : <Badge tone="bad">Unavailable</Badge>}
                            {v.reason ? <div className="muted">{v.reason}</div> : null}
                            {v.cooldown_until ? (
                              <div className="muted">
                                cooling down for <Countdown to={v.cooldown_until} />
                              </div>
                            ) : null}
                          </td>
                        </tr>
                      ))}
                      <tr>
                        <th scope="row">Opposite-side flow</th>
                        <td colSpan={3} className="muted">
                          Built in: tighten the buy-side deviation to attract takers selling XMR. Slow, but nobody holds the funds.
                        </td>
                      </tr>
                    </tbody>
                  </table>
                </Card>
              </div>

              <Card title="In transit" note="Funds with a venue right now. A held or failed refill keeps counting against the cap until it is resolved." flush>
                {moving.length === 0 ? (
                  <Empty title="Nothing is in transit" />
                ) : (
                  <RefillTable
                    label="Refills in transit"
                    refills={moving}
                    actions={(x) =>
                      x.state === 'pending' ? (
                        <Button small busy={busy === `cancel:${x.id}`} onClick={() => void cancel(x.id)}>
                          Cancel
                        </Button>
                      ) : x.state === 'held' && x.needs_acknowledgement !== false ? (
                        <span className="row" style={{ justifyContent: 'flex-end' }}>
                          <ConfirmButton label="Continue" small busy={busy === `ack:${x.id}:continue`} onConfirm={() => void ack(x.id, 'continue')}>
                            Tell {venueLabel(x.venue)} to continue this order at its new rate. The funds stay with the venue until it pays out.
                          </ConfirmButton>
                          <ConfirmButton label="Refund" small busy={busy === `ack:${x.id}:refund`} onConfirm={() => void ack(x.id, 'refund')}>
                            Ask {venueLabel(x.venue)} to send the deposit back, minus its network fee.
                          </ConfirmButton>
                          <ConfirmButton label="Close as dealt with" small variant="danger" busy={busy === `ack:${x.id}:`} onConfirm={() => void ack(x.id)}>
                            Mark this order as settled outside the console. It is closed as failed and stops counting against the in-transit cap. Do this only once you have the funds back or have written them off.
                          </ConfirmButton>
                        </span>
                      ) : x.state === 'failed' && (x.needs_acknowledgement ?? !x.acknowledged) ? (
                        <ConfirmButton label="Acknowledge" small busy={busy === `ack:${x.id}:`} onConfirm={() => void ack(x.id)}>
                          Confirm you have checked this failed refill. It stops counting against the in-transit cap.
                        </ConfirmButton>
                      ) : null
                    }
                  />
                )}
              </Card>

              <Card
                title="Cost log"
                note={avgCost === null ? 'Every refill is logged with venue, rate, fees and time.' : `Every refill is logged with venue, rate, fees and time. Completed refills averaged ${fmtPct(avgCost, 2)} against the reference and paid ${fmtUsd(totalFees)} in fees; the measured cost feeds the offer engine.`}
                flush
              >
                {history.length === 0 ? <Empty title="No refills yet">Completed, cancelled and refunded refills are listed here.</Empty> : <RefillTable label="Refill history" refills={history} />}
              </Card>

              <div className="cols-2">
                <Card title="Address allow-list" note="Refills pay out only to your own addresses.">
                  {isTable(allow) && Object.values(allow).some((v) => Array.isArray(v) && v.length > 0) ? (
                    <dl className="kv">
                      {(['xmr', 'sol', 'eth'] as const).map((k) => (
                        <div key={k} style={{ display: 'contents' }}>
                          <dt>{k.toUpperCase()}</dt>
                          <dd>
                            {Array.isArray(allow[k]) && (allow[k] as unknown[]).length > 0 ? (
                              (allow[k] as string[]).map((a) => (
                                <div key={a}>
                                  <code style={{ overflowWrap: 'anywhere' }}>{a}</code>
                                </div>
                              ))
                            ) : (
                              <span className="muted">daemon default</span>
                            )}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  ) : (
                    <p>
                      No addresses are listed in the configuration, so the daemon allows only its defaults: the inventory wallet and your operator and payout addresses. A payout to any other address is refused.
                    </p>
                  )}
                </Card>
                {parsed ? <WithdrawKeysCard key={config.data?.revision} cfg={parsed} onSaved={config.reload} /> : null}
                <ManualForms venues={r.venues.filter((v) => v.enabled).map((v) => v.id)} onDone={reb.reload} />
              </div>
            </div>
          );
        }}
      </Async>
    </>
  );
}

function ManualForms({ venues, onDone }: { venues: VenueId[]; onDone: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const id = useId();
  const [kind, setKind] = useState<'run' | 'record'>('run');
  const [from, setFrom] = useState<AssetId>('usdc_sol');
  const [to, setTo] = useState<AssetId>('xmr');
  const [amountIn, setAmountIn] = useState('');
  const [amountOut, setAmountOut] = useState('');
  const [venue, setVenue] = useState<VenueId | ''>('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const submit = async (): Promise<void> => {
    setError(null);
    if (from === to) return setError('Choose two different assets.');
    let inAtomic: bigint;
    let outAtomic: bigint | null = null;
    try {
      inAtomic = parseUnits(amountIn, ASSET_DECIMALS[from]);
      if (kind === 'record') outAtomic = parseUnits(amountOut, ASSET_DECIMALS[to]);
    } catch {
      return setError('Enter amounts as plain decimals, for example 2500 or 0.5.');
    }
    if (inAtomic <= 0n || (outAtomic !== null && outAtomic <= 0n)) return setError('Amounts must be more than 0.');
    const r =
      kind === 'run'
        ? await run('manual', () => client.call('rebalanceRun', { body: { from, to, amount_in: inAtomic.toString(), ...(venue ? { venue } : {}) } }), (x) => (x.state === 'awaiting_approval' ? 'Refill created. It waits for your approval above.' : 'Refill started.'))
        : await run('manual', () => client.call('rebalanceManual', { body: { from, to, amount_in: inAtomic.toString(), amount_out: (outAtomic as bigint).toString(), ...(note.trim() ? { note: note.trim() } : {}) } }), 'Recorded. Inventory and cost tracking include it.');
    if (r) {
      setAmountIn('');
      setAmountOut('');
      setNote('');
      onDone();
    }
  };
  const assetSelect = (label: string, value: AssetId, set: (a: AssetId) => void, sid: string) => (
    <div className="field">
      <label htmlFor={sid}>{label}</label>
      <select id={sid} value={value} onChange={(e) => set(e.target.value as AssetId)}>
        {ASSETS.map((a) => (
          <option key={a} value={a}>
            {ASSET_LABEL[a]}
          </option>
        ))}
      </select>
    </div>
  );
  return (
    <Card title="Manual run or record">
      <div className="row" role="radiogroup" aria-label="What to do" style={{ marginBottom: 10 }}>
        <label className="row" style={{ gap: 4 }}>
          <input type="radio" name={`${id}-kind`} checked={kind === 'run'} onChange={() => setKind('run')} /> Run a refill now
        </label>
        <label className="row" style={{ gap: 4 }}>
          <input type="radio" name={`${id}-kind`} checked={kind === 'record'} onChange={() => setKind('record')} /> Record a refill done elsewhere
        </label>
      </div>
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: '8px 12px' }}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {assetSelect('From', from, setFrom, `${id}-from`)}
        {assetSelect('To', to, setTo, `${id}-to`)}
        <div className="field">
          <label htmlFor={`${id}-in`}>Amount in ({ASSET_UNIT[from]})</label>
          <input id={`${id}-in`} type="text" inputMode="decimal" className="w-num" style={{ width: '14ch' }} value={amountIn} onChange={(e) => setAmountIn(e.target.value)} />
        </div>
        {kind === 'run' ? (
          <div className="field">
            <label htmlFor={`${id}-venue`}>Venue</label>
            <select id={`${id}-venue`} value={venue} onChange={(e) => setVenue(e.target.value as VenueId | '')}>
              <option value="">By your routing rules</option>
              {venues.map((v) => (
                <option key={v} value={v}>
                  {VENUE_LABEL[v]}
                </option>
              ))}
            </select>
          </div>
        ) : (
          <>
            <div className="field">
              <label htmlFor={`${id}-out`}>Amount received ({ASSET_UNIT[to]})</label>
              <input id={`${id}-out`} type="text" inputMode="decimal" className="w-num" style={{ width: '14ch' }} value={amountOut} onChange={(e) => setAmountOut(e.target.value)} />
            </div>
            <div className="field" style={{ flex: 1, minWidth: 160 }}>
              <label htmlFor={`${id}-note`}>Note</label>
              <input id={`${id}-note`} type="text" className="w-wide" value={note} onChange={(e) => setNote(e.target.value)} />
            </div>
          </>
        )}
        <button type="submit" className="btn primary" disabled={busy === 'manual'}>
          {kind === 'run' ? 'Run refill' : 'Record refill'}
        </button>
      </form>
      {error ? (
        <p className="msg error" role="alert" style={{ marginTop: 6 }}>
          <b>Error:</b> {error}
        </p>
      ) : null}
      <p className="muted" style={{ marginTop: 8 }}>
        {kind === 'run' ? 'A manual run still obeys the cost limit, the caps, the allow-list and the test transfer.' : 'Nothing is sent: this only keeps inventory and cost tracking correct.'}
      </p>
    </Card>
  );
}

/**
 * `[rebalance.venues.exchange.withdraw_keys]`: your own withdrawal address and the key name the
 * exchange has registered for it. The rebalancer withdraws only to an address that is both
 * allow-listed and has a key.
 */
function WithdrawKeysCard({ cfg, onSaved }: { cfg: Toml; onSaved: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const id = useId();
  const [rows, setRows] = useState<Record<string, string>>(() => withdrawKeys(cfg));
  const [address, setAddress] = useState('');
  const [name, setName] = useState('');
  const saved = withdrawKeys(cfg);
  const dirty = JSON.stringify(rows) !== JSON.stringify(saved);
  const draft = setPath(cfg, 'rebalance.venues.exchange.withdraw_keys', Object.keys(rows).length === 0 ? undefined : rows);
  const problems = withdrawKeyProblems(draft);
  const noList = allowlisted(cfg).length === 0;
  const missing = problems.filter((p) => p.problem === 'no_key');
  const add = (a: string, k: string): void => {
    if (a.trim() === '' || k.trim() === '') return;
    setRows((r) => ({ ...r, [a.trim()]: k.trim() }));
    setAddress('');
    setName('');
  };
  const save = async (): Promise<void> => {
    const res = await run('keys', () => patchConfig(client, (c) => setPath(c, 'rebalance.venues.exchange.withdraw_keys', Object.keys(rows).length === 0 ? undefined : rows)), 'Withdrawal keys saved and applied without a restart.');
    if (res) onSaved();
  };
  return (
    <Card title="Exchange withdrawal keys" note="Your own withdrawal address and the key name registered for it at the exchange. A withdrawal needs both an allow-list entry and a key.">
      {Object.keys(rows).length === 0 && missing.length === 0 ? (
        <p className="muted">No keys. The exchange cannot withdraw to any address until one is added.</p>
      ) : (
        <div className="table-wrap">
          <table className="tbl" aria-label="Exchange withdrawal keys">
            <thead>
              <tr>
                <th scope="col">Withdrawal address</th>
                <th scope="col">Key name at the exchange</th>
                <th scope="col">
                  <span className="sr-only">Remove</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(rows).map(([a, k]) => {
                const bad = problems.some((p) => p.address === a && p.problem === 'not_allowlisted');
                return (
                  <tr key={a} className={bad ? 'attention' : undefined}>
                    <th scope="row">
                      <code style={{ overflowWrap: 'anywhere' }}>{a}</code>
                      {bad ? (
                        <p className="msg warning">
                          <b>Warning:</b> not on the address allow-list. The rebalancer refuses withdrawals to it until it is listed.
                        </p>
                      ) : null}
                    </th>
                    <td>
                      <input type="text" aria-label={`Key name for ${a}`} value={k} onChange={(e) => setRows((r) => ({ ...r, [a]: e.target.value }))} />
                    </td>
                    <td className="actions">
                      <Button small variant="ghost" aria-label={`Remove the key for ${a}`} onClick={() => setRows((r) => Object.fromEntries(Object.entries(r).filter(([x]) => x !== a)))}>
                        Remove
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {missing.map((p) => (
                <tr key={`missing-${p.address}`} className="attention">
                  <th scope="row">
                    <code style={{ overflowWrap: 'anywhere' }}>{p.address}</code>
                    <p className="msg warning">
                      <b>Warning:</b> allow-listed, but it has no withdrawal key. The exchange cannot withdraw to it.
                    </p>
                  </th>
                  <td className="muted">no key</td>
                  <td className="actions">
                    <Button small onClick={() => setAddress(p.address)} aria-label={`Add a key for ${p.address}`}>
                      Add a key
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {noList && Object.keys(rows).length > 0 ? <p className="muted">No allow-list is set in the configuration, so the daemon’s default list applies (inventory wallet, operator and payout addresses); these addresses cannot be checked against it here.</p> : null}
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: '8px 12px', marginTop: 10 }}
        onSubmit={(e) => {
          e.preventDefault();
          add(address, name);
        }}
      >
        <div className="field" style={{ flex: 1, minWidth: 200 }}>
          <label htmlFor={`${id}-a`}>Withdrawal address</label>
          <input id={`${id}-a`} type="text" className="w-wide" spellCheck={false} value={address} onChange={(e) => setAddress(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor={`${id}-k`}>Key name</label>
          <input id={`${id}-k`} type="text" spellCheck={false} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <button type="submit" className="btn" disabled={address.trim() === '' || name.trim() === ''}>
          Add key
        </button>
      </form>
      <div className="row" style={{ marginTop: 10 }}>
        <Button variant="primary" disabled={!dirty || Object.values(rows).some((k) => k.trim() === '')} busy={busy === 'keys'} onClick={() => void save()}>
          Save withdrawal keys
        </Button>
        <Button disabled={!dirty} onClick={() => setRows(saved)}>
          Discard
        </Button>
      </div>
    </Card>
  );
}
