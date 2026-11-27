/** Every maker's offers from the registry, ranked by completed volume, with each maker's merged history (SPEC 8.2). */
import type { Market } from '@xmrswap/protocol';
import { useState } from 'react';
import { ASSET_LABEL, MARKET_LABEL, bpsPercent, formatAsset, formatDuration, formatPercent, formatPrice, formatXmrAmount } from '../lib/format.js';
import { NOT_OPEN_TITLE, capsLine, capsState, notOpenText } from '../lib/caps.js';
import { type OfferRow, rankRows, referenceFor, vsReferenceBps } from '../lib/market.js';
import { settingsProblems } from '../lib/settings.js';
import { href, useApp, useObs } from '../ui/hooks.js';
import { Empty, Notice, Segmented, SkeletonRows } from '../ui/kit.js';

export const MODE_LABEL: Readonly<Record<number, string>> = { 0: 'Auto-accept', 1: 'Approve within a window', 2: 'Approved in advance', 3: 'Quote' };
const MARKETS: readonly { value: Market; label: string }[] = [
  { value: 'sol', label: 'SOL' },
  { value: 'usdc_sol', label: 'USDC · Solana' },
  { value: 'eth', label: 'ETH' },
  { value: 'usdc_eth', label: 'USDC · Ethereum' },
];

export function MakerHistory({ row }: { row: Pick<OfferRow, 'maker'> }) {
  const rep = row.maker.identity.reputation;
  const per = (n: number) => (rep.completed > 0 ? ` (${((n / rep.completed) * 100).toFixed(1)} per 100 completed)` : '');
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
      <dt className="faint">Completed</dt>
      <dd className="m-0">
        <span className="num">{rep.completed}</span> swap{rep.completed === 1 ? '' : 's'}
        {row.maker.identity.merged ? ' on Solana and Ethereum combined' : ''}
      </dd>
      <dt className="faint">Approval rate</dt>
      <dd className="m-0">
        {formatPercent(rep.approvalRate)}
        {rep.meanResponseSecs !== null ? `, answers in about ${formatDuration(Math.round(rep.meanResponseSecs))}` : ''}
        {rep.rejectionsNoFault > 0 ? ` (${rep.rejectionsNoFault} rejection${rep.rejectionsNoFault === 1 ? '' : 's'} it blames on the taker, not counted)` : ''}
      </dd>
      <dt className="faint">Missed deadlines</dt>
      <dd className={`m-0 ${rep.faults.total > 0 ? 'text-warn-text font-semibold' : ''}`}>
        <span className="num">{rep.faults.total}</span>
        {per(rep.faults.total)}
      </dd>
      <dt className="faint">Withheld deposits</dt>
      <dd className={`m-0 ${rep.counts.withholds > 0 ? 'text-warn-text font-semibold' : ''}`}>
        <span className="num">{rep.counts.withholds}</span>
        {rep.withholdRate !== null ? `, ${formatPercent(rep.withholdRate)} of refunds` : ''}
        {per(rep.counts.withholds)}
        {rep.counts.withholds > 0 ? `; ${rep.unreleased} never released (${formatPercent(rep.unreleasedRate)})` : ''}
      </dd>
    </dl>
  );
}

function OfferItem({ row, refPrice, refSource }: { row: OfferRow; refPrice: bigint | null; refSource: string }) {
  const asset = ASSET_LABEL[row.market];
  const bps = refPrice !== null ? vsReferenceBps(row.basePrice, refPrice) : null;
  const better = bps !== null && (row.direction === 0 ? bps <= 0 : bps >= 0);
  const depth = (() => {
    try {
      return row.depthFor(row.minXmr);
    } catch {
      return null;
    }
  })();
  return (
    <li className="grid gap-4 p-4 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)_auto] sm:items-start sm:gap-6" data-testid="offer" data-offer={row.id}>
      <div className="grid gap-1">
        <div className="figure">{formatPrice(row.basePrice, row.market)}</div>
        <div className="text-sm muted">
          per XMR
          {bps !== null ? (
            <>
              {' · '}
              <span className={better ? 'text-safe-text' : 'text-warn-text'}>
                {bps === 0 ? 'at' : `${Math.abs(bps / 100).toFixed(2)}% ${bps > 0 ? 'above' : 'below'}`} {refSource}
              </span>
            </>
          ) : null}
        </div>
        <div className="mt-1 flex flex-wrap gap-1.5">
          <span className={row.mode === 0 ? 'pill' : 'pill pill-warn'}>
            {MODE_LABEL[row.mode]}
            {row.startsPending && row.approvalWindow > 0 ? `, up to ${formatDuration(row.approvalWindow)}` : ''}
          </span>
          {row.chain === 'ethereum' ? <span className="pill">Ethereum</span> : null}
          {row.freezeWindow > 0 ? <span className="pill">Pause window {formatDuration(row.freezeWindow)}</span> : null}
        </div>
      </div>
      <div className="grid gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
          <dt className="faint">Size</dt>
          <dd className="m-0 num">
            {formatXmrAmount(row.minXmr, 4)} to {formatXmrAmount(row.maxXmr < row.capacityXmr ? row.maxXmr : row.capacityXmr, 4)} XMR
          </dd>
          <dt className="faint">Confirmations</dt>
          <dd className="m-0">{depth === null ? 'by size' : `${depth} for small swaps, more for larger`}</dd>
          <dt className="faint">Deposit</dt>
          <dd className="m-0">{row.depBps === 0 ? 'none' : `${bpsPercent(row.depBps)}, can be withheld if you refund`}</dd>
          <dt className="faint">Claim delay</dt>
          <dd className="m-0">{formatDuration(row.claimDelay)} after the maker's lock notice</dd>
        </dl>
        <div>
          <a className="text-sm font-semibold" href={href('maker', row.maker.pda)}>
            Maker {row.maker.pda.slice(0, 8)}…
          </a>
          <span className="text-sm faint"> · volume {formatAsset(row.volume, row.market, 2)} {asset}</span>
          <div className="mt-1">
            <MakerHistory row={row} />
          </div>
        </div>
      </div>
      <div className="grid gap-1 sm:justify-items-end">
        {row.problem ? (
          <>
            <button type="button" className="btn" disabled aria-describedby={`p-${row.id}`}>
              Unavailable
            </button>
            <span id={`p-${row.id}`} className="text-sm muted sm:max-w-48 sm:text-right">
              {row.problem}
            </span>
          </>
        ) : (
          <a className="btn btn-primary" href={href('swap', 'new', row.id)}>
            {row.direction === 0 ? 'Buy XMR' : 'Sell XMR'}
          </a>
        )}
      </div>
    </li>
  );
}

export function OffersPage() {
  const app = useApp();
  const registry = useObs(app.registry);
  const settings = useObs(app.settings);
  const [direction, setDirection] = useState<0 | 1>(0);
  const [market, setMarket] = useState<Market>('sol');
  const [mode, setMode] = useState<number | null>(null);
  const problems = settingsProblems(settings);
  const rows = registry.snapshot ? rankRows(registry.snapshot.rows, { market, direction, mode }) : [];
  const ref = registry.snapshot ? referenceFor(market, registry.snapshot.rows.filter((r) => r.direction === direction), settings) : null;
  const refSource = ref?.source === 'settings' ? 'your reference' : 'the median offer';
  const caps = registry.snapshot?.caps[market];
  const ethOff = (market === 'eth' || market === 'usdc_eth') && !settings.ethereumRpc;

  return (
    <div className="grid gap-6">
      <header className="grid gap-2">
        <h1>{direction === 0 ? 'Buy XMR' : 'Sell XMR'} directly from makers</h1>
        <p className="muted prose-w">An atomic swap with no custodian. Keys, checks, refunds and the final sweep all run in this page; the site and the relay never hold a key, which also means they cannot rescue a swap if this tab closes at the wrong moment.</p>
      </header>

      {problems.some((p) => p.field === 'solanaRpc') ? (
        <Empty title="Choose a Solana RPC to see offers">
          <p>The registry of makers and offers lives in a Solana program. This site has no default RPC: whoever runs it sees your queries. Set one in Settings, along with at least two Monero nodes.</p>
          <p className="mt-4">
            <a className="btn btn-primary" href={href('settings')}>
              Open Settings
            </a>
          </p>
        </Empty>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <Segmented label="Direction" value={direction} onChange={setDirection} options={[{ value: 0, label: 'Buy XMR' }, { value: 1, label: 'Sell XMR' }]} />
            <Segmented label={direction === 0 ? 'Pay with' : 'Receive'} value={market} onChange={setMarket} options={MARKETS} />
            <label className="flex items-center gap-2 text-sm">
              <span className="label">Approval</span>
              <select className="select !w-auto" value={mode === null ? '' : String(mode)} onChange={(e) => setMode(e.target.value === '' ? null : Number(e.target.value))}>
                <option value="">Any mode</option>
                <option value="0">Auto-accept</option>
                <option value="1">Approve within a window</option>
                <option value="2">Approved in advance</option>
              </select>
            </label>
            <button type="button" className="btn btn-quiet btn-sm" onClick={() => void app.refreshRegistry()} disabled={registry.loading}>
              {registry.loading ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>

          {registry.error ? (
            <Notice kind="danger" title="The registry could not be read" role="alert">
              {registry.error} Check the Solana RPC in <a href={href('settings')}>Settings</a>; it must allow listing program accounts.
            </Notice>
          ) : null}
          {problems.some((p) => p.field === 'moneroNodes') ? (
            <Notice kind="warn" title="Monero nodes are not set up yet">
              {problems.find((p) => p.field === 'moneroNodes')!.message} You can browse offers, but locking stays disabled. <a href={href('settings')}>Open Settings</a>.
            </Notice>
          ) : null}

          {capsState(caps) === 'closed' ? (
            <Notice kind="info" title={NOT_OPEN_TITLE} role="status" id="caps-closed">
              {notOpenText(market)}
            </Notice>
          ) : capsLine(caps, market) ? (
            <p className="text-sm muted" data-testid="caps-line">
              {capsLine(caps, market)} These are limits of the protocol during its beta, not of any maker.
            </p>
          ) : null}

          {ethOff ? (
            <Empty title="Ethereum markets are switched off">
              <p>Set an Ethereum RPC URL and the contract address in Settings to see ETH and USDC-on-Ethereum offers.</p>
            </Empty>
          ) : registry.snapshot === null ? (
            <SkeletonRows rows={4} />
          ) : rows.length === 0 ? (
            <Empty title="No offers in this market right now">
              <p>
                No maker is {direction === 0 ? 'selling' : 'buying'} XMR for {MARKET_LABEL[market]}
                {mode !== null ? ` in "${MODE_LABEL[mode]}" mode` : ''}. Try another asset or approval mode, or refresh: makers republish their offers every few seconds.
              </p>
            </Empty>
          ) : (
            <section aria-label="Offers" className="grid gap-2">
              <p className="text-sm muted">
                {rows.length} offer{rows.length === 1 ? '' : 's'}, makers with the most completed volume first.
                {ref ? (
                  <>
                    {' '}
                    Reference: 1 XMR = <span className="num">{formatPrice(ref.price, market)}</span> ({ref.source === 'settings' ? 'from your figures in Settings' : 'the median of these offers; set your own in Settings'}).
                  </>
                ) : null}
              </p>
              <ul className="panel m-0 list-none divide-y divide-line p-0">
                {rows.map((r) => (
                  <OfferItem key={r.id} row={r} refPrice={ref?.price ?? null} refSource={refSource} />
                ))}
              </ul>
            </section>
          )}
        </>
      )}
    </div>
  );
}
