/** Every swap of the connected wallets, rebuilt from chain state plus the recovery seed (SPEC 8.2 "Activity"). */
import { SWAP_STATE } from '@xmrswap/protocol';
import type { Tracked } from '../lib/engine.js';
import { ASSET_LABEL, formatAsset, formatTime, formatXmrAmount } from '../lib/format.js';
import { marketOf } from '../lib/market.js';
import { LEG_LABEL } from '../lib/orders.js';
import { BackupStep } from '../ui/Backup.js';
import { href, useApp, useChainNow, useEngine, useObs, useVault } from '../ui/hooks.js';
import { Countdown, Empty, SkeletonRows } from '../ui/kit.js';

function describe(t: Tracked): string {
  if (!t.view) return t.leg === 'swept' ? 'Complete. The swap account is closed.' : 'Refunded in full. The swap account is closed.';
  if (t.keys === null) return 'Opened with another recovery file: this tab cannot act for it.';
  if (t.lost) return t.lost;
  if (t.busy) return `${t.busy}…`;
  if (t.error) return `Retrying: ${t.error}`;
  const d = t.decision;
  if (!d) return '';
  if (d.do === 'done') return d.outcome === 'completed' ? 'Complete.' : d.outcome === 'refunded' ? 'Refunded.' : 'Closed.';
  if (d.do === 'offchain') return d.action === 'sweep' ? (t.sweep.phase === 'waiting' ? `The XMR is yours, spendable in ${t.sweep.blocksLeft} blocks.` : t.sweep.phase === 'failed' ? 'The sweep is being retried; nothing was spent.' : 'Sweeping the XMR.') : 'Waiting for your XMR payment.';
  if (d.do === 'wait')
    return (
      {
        approval: 'Waiting for the maker to approve.',
        funding: 'Waiting for the maker to fund.',
        notice: 'Waiting for the maker to lock XMR.',
        'xmr-confirmations': 'Waiting for Monero confirmations.',
        'ready-minimum': 'Lock confirmed; about to set ready.',
        claim: 'Ready. Waiting for the maker to complete.',
        ready: 'Waiting for the maker to confirm your payment.',
        'deposit-hold': 'Refunded. The deposit is on hold for 30 minutes.',
        'deposit-release': 'Refunded. The maker withheld the deposit.',
        expiry: 'Waiting for the expiry to refund.',
        'maker-refund': 'Waiting for the maker to take its escrow back.',
        final: 'Waiting for the final deadline.',
      } as Record<string, string>
    )[d.on] ?? d.on;
  return 'Working…';
}

export function ActivityPage() {
  const app = useApp();
  const engine = useEngine();
  const vault = useVault();
  const wallets = useObs(app.wallets);
  const orders = useObs(app.orders);
  const now = useChainNow('solana');
  const any = wallets.solana || wallets.ethereum || app.vault.wallets().solana.length > 0 || app.vault.wallets().ethereum.length > 0;

  return (
    <div className="grid gap-8">
      <header className="grid gap-2">
        <h1>Activity</h1>
        <p className="muted prose-w">Your swaps are read from the chain and their keys are re-derived from your recovery seed, so this list is the same in any browser that has the file. Anything still refundable is refunded as soon as this page opens.</p>
      </header>

      {!vault.unlocked ? <BackupStep heading="Load your recovery file to resume" /> : null}

      {orders.length > 0 ? (
        <section className="grid gap-3" aria-labelledby="orders-h">
          <h2 id="orders-h">Large swaps</h2>
          <ul className="panel m-0 list-none divide-y divide-line p-0">
            {orders.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center justify-between gap-3 p-4">
                <span>
                  <span className="num font-semibold">
                    {formatAsset(BigInt(o.totalPay), o.market)} {ASSET_LABEL[o.market]}
                  </span>{' '}
                  <span className="muted">
                    in {o.legs.length} leg{o.legs.length === 1 ? '' : 's'}, started {new Date(o.createdAt).toLocaleString()}
                  </span>
                </span>
                <a className="btn btn-sm" href={href('large', o.id)}>
                  Open the board
                </a>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className="grid gap-3" aria-labelledby="swaps-h">
        <h2 id="swaps-h">Swaps</h2>
        {!engine.ready ? (
          <SkeletonRows rows={3} />
        ) : engine.swaps.length === 0 ? (
          <Empty title={any ? 'No swaps yet' : 'Connect a wallet to see its swaps'}>
            <p>{any ? 'Swaps you open appear here and can be resumed from any browser that has your recovery file.' : 'Swaps are found by the wallet address that opened them. Connect that wallet, or load the recovery file that lists it.'}</p>
            <p className="mt-4">
              <a className="btn btn-primary" href={href()}>
                See offers
              </a>
            </p>
          </Empty>
        ) : (
          <ul className="panel m-0 list-none divide-y divide-line p-0">
            {engine.swaps.map((t) => {
              const market = t.note.market ?? (t.view ? marketOf(t.chain, t.view.asset) : 'sol');
              const amount = t.view?.amount ?? BigInt(t.note.amount ?? '0');
              const xmr = t.view?.xmr ?? BigInt(t.note.xmr ?? '0');
              const buying = (t.view?.direction ?? t.note.direction ?? 0) === 0;
              return (
                <li key={t.ref} className="grid gap-2 p-4 sm:grid-cols-[1fr_auto] sm:items-center" data-testid="activity-swap" data-leg={t.leg}>
                  <div className="grid gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-semibold">
                        {buying ? 'Buy' : 'Sell'} <span className="num">{formatXmrAmount(xmr, 4)}</span> XMR {buying ? 'for' : 'for'} <span className="num">{formatAsset(amount, market)}</span> {ASSET_LABEL[market]}
                      </span>
                      {t.atRisk ? <span className="pill pill-risk">At risk</span> : <span className={t.view?.state === SWAP_STATE.READY ? 'pill pill-safe' : 'pill'}>{LEG_LABEL[t.leg]}</span>}
                      {t.atRisk && t.refundDeadline !== null ? (
                        <span className="text-sm text-danger-text">
                          refund deadline in <Countdown to={t.refundDeadline} now={now} />
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm muted">
                      {describe(t)}
                      {t.note.openedAt ? ` Opened ${formatTime(t.note.openedAt, now ?? undefined)}.` : ''}
                    </p>
                  </div>
                  <a className="btn btn-sm" href={href('swap', t.ref)}>
                    Open
                  </a>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
