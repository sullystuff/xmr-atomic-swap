/**
 * The offer-update cost panel (DESIGN "Offer updates and daily cost"): the live daily estimate in
 * SOL with a dollar figure, the last 24 hours' actual spend, the runway with its alert
 * threshold, the range for move-triggered updates, and the occasional costs listed apart.
 */
import type { FeesResponse, OffersResponse } from '@xmrswap/protocol/daemon-api';
import { BASE_FEE_LAMPORTS, dailyCostLamports, lamportsToUsd, runwayDays, updatesPerDay, type CostBreakdown } from '../lib/cost.js';
import { fmtAsset, fmtInt, fmtSol, fmtUsd } from '../lib/format.js';
import { Notice, Stat } from './kit.js';

const OCCASIONAL_LABEL: Record<OffersResponse['occasional'][number]['kind'], { label: string; note: string }> = {
  key_refill: { label: 'Key-pool refills', note: 'One transaction per eight fills on an auto-accept offer' },
  key_rotation: { label: 'Key rotations', note: 'One transaction per rotation' },
  quote_on_request: { label: 'Quotes posted on request', note: 'A small on-chain account per quote, paid by you' },
  eth_registry: { label: 'Ethereum registry changes', note: 'Paid in ETH' },
};

/** DESIGN's comparison intervals. */
export const COMPARE_INTERVALS = [1, 5, 10, 30, 60] as const;

export interface CostPanelProps {
  cost: CostBreakdown;
  intervalSecs: number;
  solUsd: number | null;
  fees: FeesResponse | undefined;
  offers: OffersResponse | undefined;
  /** The figures describe unsaved settings. */
  draft?: boolean;
}

export function CostPanel({ cost, intervalSecs, solUsd, fees, offers, draft }: CostPanelProps) {
  const balance = fees?.operator_balances.find((b) => b.chain === 'solana' && b.asset === 'sol');
  const runway = balance ? runwayDays(BigInt(balance.balance), cost.dailyLamports) : (fees?.runway_days ?? null);
  const alertDays = fees?.runway_alert_days ?? null;
  const low = runway !== null && alertDays !== null && runway < alertDays;
  const spent = offers ? BigInt(offers.spent_24h_lamports) : null;
  const t = cost.triggered;
  return (
    <div className="stack">
      <dl className="stats" aria-label={draft ? 'Offer-update cost with these settings' : 'Offer-update cost'}>
        <Stat
          label={draft ? 'Daily cost with these settings' : 'Daily cost'}
          value={<span data-testid="daily-sol">{fmtSol(cost.dailyLamports)}</span>}
          hint={
            <>
              <span data-testid="daily-usd">{cost.dailyUsd === null ? 'dollar price unavailable' : `about ${fmtUsd(cost.dailyUsd)}`}</span> · {fmtInt(cost.updatesPerDay)} updates × {fmtInt(Number(cost.perUpdateLamports))} lamports
            </>
          }
        />
        <Stat
          label="Last 24 hours, actual"
          value={<span data-testid="spent-sol">{spent === null ? 'n/a' : fmtSol(spent)}</span>}
          hint={spent === null ? 'not reported' : `about ${fmtUsd(lamportsToUsd(spent, solUsd))} on offer updates`}
        />
        <Stat
          label="Runway"
          tone={low ? 'bad' : undefined}
          value={<span data-testid="runway">{runway === null ? 'n/a' : `${runway.toFixed(1)} days`}</span>}
          hint={
            <>
              {balance ? `fee wallet holds ${fmtSol(balance.balance, 4)}` : 'fee wallet balance not reported'}
              {alertDays !== null ? ` · alert below ${alertDays} days` : ''}
            </>
          }
        />
        {t ? (
          <Stat
            label="Move-triggered updates"
            value={
              <span data-testid="triggered">
                {t.expectedLamports === null ? 'n/a' : fmtSol(t.expectedLamports)} expected, {fmtSol(t.maxLamports)} at most
              </span>
            }
            hint={
              <>
                {t.expectedPerDay === null ? 'expected count not reported' : `about ${fmtInt(t.expectedPerDay)} updates a day`}, at most {fmtInt(t.maxPerDay)}
                {t.maxUsd !== null ? ` (${t.expectedUsd === null ? 'n/a' : fmtUsd(t.expectedUsd)} to ${fmtUsd(t.maxUsd)})` : ''}
              </>
            }
          />
        ) : null}
      </dl>
      {low ? (
        <Notice tone="bad" title="The fee wallet is running low.">
          At this rate it covers {runway?.toFixed(1)} days of updates, below your alert threshold of {alertDays} days. Top up the operator wallet or lengthen the interval; when it runs dry your offers lapse.
        </Notice>
      ) : null}
      <p className="muted">
        Daily cost = 86,400 ÷ interval × (5,000 lamports + priority fee). One transaction refreshes every market, including the signed quotes for the Ethereum markets, so the cost does not multiply by the number of markets.
        {cost.priorityLamports > 0n ? ` The priority fee adds ${fmtInt(Number(cost.priorityLamports))} lamports to each update.` : ''}
      </p>
      <div className="cols-2">
        <div>
          <h3 className="subhead">Compare intervals</h3>
          <table className="tbl" aria-label="Daily cost by update interval">
            <thead>
              <tr>
                <th scope="col">Update interval</th>
                <th scope="col" className="num">
                  Updates per day
                </th>
                <th scope="col" className="num">
                  Daily cost
                </th>
              </tr>
            </thead>
            <tbody>
              {[...new Set([...COMPARE_INTERVALS, intervalSecs])]
                .filter((s) => s > 0)
                .sort((a, b) => a - b)
                .map((s) => {
                  const daily = dailyCostLamports(s, cost.perUpdateLamports);
                  return (
                    <tr key={s} className={s === intervalSecs ? 'attention' : undefined} aria-current={s === intervalSecs ? 'true' : undefined}>
                      <td>
                        {s === 1 ? '1 second' : `${s} seconds`}
                        {s === intervalSecs ? <span className="muted"> (yours)</span> : null}
                      </td>
                      <td className="num">{fmtInt(updatesPerDay(s))}</td>
                      <td className="num">
                        {fmtSol(daily)}
                        {solUsd !== null ? <span className="muted"> · {fmtUsd(lamportsToUsd(daily, solUsd))}</span> : null}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
          {cost.perUpdateLamports === BASE_FEE_LAMPORTS ? <p className="muted">At the base fee of 5,000 lamports per update.</p> : null}
        </div>
        <div>
          <h3 className="subhead">Occasional costs, last 24 hours</h3>
          {offers ? (
            <table className="tbl" aria-label="Occasional costs">
              <thead>
                <tr>
                  <th scope="col">Cost</th>
                  <th scope="col" className="num">
                    Count
                  </th>
                  <th scope="col" className="num">
                    Paid
                  </th>
                </tr>
              </thead>
              <tbody>
                {offers.occasional.map((o) => (
                  <tr key={o.kind}>
                    <td>
                      {OCCASIONAL_LABEL[o.kind].label}
                      <div className="muted">{OCCASIONAL_LABEL[o.kind].note}</div>
                    </td>
                    <td className="num">{o.count_24h}</td>
                    <td className="num">{fmtAsset(o.asset, o.cost, 9)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">Not reported yet.</p>
          )}
          <p className="muted">These are not part of the daily estimate.</p>
        </div>
      </div>
    </div>
  );
}
