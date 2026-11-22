/** Dashboard, Swaps, Approvals, Deposits and Inbox. */
import { useId, useMemo, useState } from 'react';
import { MARKETS, SWAP_STATE_NAMES, type ChainName, type Market, type SwapStateName } from '@xmrswap/protocol';
import type { AdvanceApprovalRecord, Alert, DepositView, InboxItem, SwapDeadlines, SwapSummary, SwapsQuery } from '@xmrswap/protocol/daemon-api';
import { ApiFailure } from '../api/client.js';
import { useAction, useChainNow, useClient, useLive, useNow, useQuery } from '../api/hooks.js';
import { chainLabel } from '../lib/config/schema.js';
import { MARKET_LABEL, fmtInt, fmtMarketAmount, fmtRate, fmtTime, fmtUnits, fmtUsd, fmtXmr, parseUnits } from '../lib/format.js';
import { ACTION_NOUN, DIR_LABEL, DepositSummary, InstructionNote, MessageThread, StateBadge, SwapActions, SwapLink, refusalText } from '../ui/domain.js';
import { OwnerTransaction, TxNotice } from '../ui/owner-tx.js';
import { Async, Badge, Button, Card, ConfirmButton, Countdown, Empty, Id, Notice, PageHead, Stat, Time } from '../ui/kit.js';

// ------------------------------------------------------------------ dashboard

const LEVEL_TONE = { info: 'info', warning: 'warn', critical: 'bad' } as const;
const LEVEL_LABEL = { info: 'Info', warning: 'Warning', critical: 'Critical' } as const;

export function AlertList({ alerts }: { alerts: Alert[] }) {
  const client = useClient();
  const { refresh } = useLive();
  const { busy, run } = useAction();
  const sorted = [...alerts].sort((a, b) => Number(a.acknowledged) - Number(b.acknowledged) || b.at - a.at);
  if (sorted.length === 0) return <Empty title="No alerts">Nothing needs your attention.</Empty>;
  return (
    <div className="table-wrap">
      <table className="tbl" aria-label="Alerts">
        <thead>
          <tr>
            <th scope="col">Level</th>
            <th scope="col">When</th>
            <th scope="col">Alert</th>
            <th scope="col">
              <span className="sr-only">Acknowledge</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((a) => (
            <tr key={a.id} className={a.acknowledged ? undefined : 'attention'}>
              <td>
                <Badge tone={LEVEL_TONE[a.level]}>{LEVEL_LABEL[a.level]}</Badge>
              </td>
              <td style={{ whiteSpace: 'nowrap' }}>
                <Time at={a.at} />
              </td>
              <td>
                {a.message} {a.swap_ref ? <SwapLink swapRef={a.swap_ref} /> : null} {a.acknowledged ? <span className="muted">(acknowledged)</span> : null}
              </td>
              <td className="actions">
                {a.acknowledged ? null : (
                  <Button small busy={busy === a.id} aria-label={`Acknowledge alert: ${a.message}`} onClick={() => void run(a.id, () => client.acknowledgeAlert(a.id)).then(refresh)}>
                    Acknowledge
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DashboardPage() {
  const stats = useQuery('stats', undefined, ['swaps']);
  const fees = useQuery('fees');
  const rebalance = useQuery('rebalance', undefined, ['rebalance']);
  const { status, swaps, inbox } = useLive();
  const pending = swaps?.filter((s) => s.state === 'PENDING').length ?? 0;
  const held = swaps?.filter((s) => s.state === 'HOLD').length ?? 0;
  const unread = inbox?.filter((m) => m.direction === 'in' && !m.read).length ?? 0;
  const review = status?.needs_review ?? 0;
  const refills = rebalance.data?.refills.filter((r) => r.state === 'awaiting_approval').length ?? 0;
  const attention: { n: number; text: string; href: string }[] = [
    { n: review, text: review === 1 ? 'swap is parked for you to review' : 'swaps are parked for you to review', href: '#/swaps' },
    { n: pending, text: pending === 1 ? 'lock is waiting for approval' : 'locks are waiting for approval', href: '#/approvals' },
    { n: held, text: held === 1 ? 'deposit is in its 30-minute hold' : 'deposits are in their 30-minute hold', href: '#/deposits' },
    { n: unread, text: unread === 1 ? 'unread message' : 'unread messages', href: '#/inbox' },
    { n: refills, text: refills === 1 ? 'refill is waiting for approval' : 'refills are waiting for approval', href: '#/rebalancing' },
  ].filter((a) => a.n > 0);
  const runway = fees.data?.runway_days ?? null;
  const runwayLow = runway !== null && fees.data !== undefined && runway < fees.data.runway_alert_days;

  return (
    <>
      <PageHead title="Dashboard">Makers and takers both judge a maker on this history. Rates are your public on-chain record, merged across both chains.</PageHead>
      <div className="stack">
        <Card title="History" flush>
          <Async query={stats} what="the statistics">
            {(s) => (
              <>
                <dl className="stats" style={{ border: 0, borderRadius: 0 }}>
                  <Stat label="Fills" value={fmtInt(s.fills)} hint={`since ${fmtTime(s.since).slice(0, 10)}`} />
                  <Stat label="Spread earned" value={fmtUsd(s.spread_earned_usd)} />
                  <Stat label="Approval rate" value={fmtRate(s.rates.approval)} hint={s.rates.mean_response_secs === null ? undefined : `typical response ${s.rates.mean_response_secs.toFixed(1)} s`} />
                  <Stat label="Abort rate" value={fmtRate(s.rates.abort)} tone={s.rates.abort !== null && s.rates.abort > 0.05 ? 'warn' : undefined} />
                  <Stat label="Withhold rate" value={fmtRate(s.rates.withhold)} hint="of refunds with a deposit" tone={s.rates.withhold !== null && s.rates.withhold > 0.05 ? 'warn' : undefined} />
                  <Stat label="Unreleased rate" value={fmtRate(s.rates.unreleased)} hint="withheld and never released" />
                  <Stat label="Missed deadlines" value={fmtInt(s.missed_deadlines)} hint="recorded publicly against you" tone={s.missed_deadlines > 0 ? 'bad' : undefined} />
                  <Stat label="Uptime" value={s.uptime_pct === null ? 'n/a' : `${s.uptime_pct.toFixed(2)}%`} hint={status ? `running ${Math.floor(status.uptime_secs / 86_400)} days` : undefined} />
                </dl>
              </>
            )}
          </Async>
        </Card>

        <div className="cols-2">
          <Card title="Needs you">
            {attention.length === 0 ? (
              <Empty title="Nothing is waiting">Approvals, held deposits, messages and parked swaps show up here.</Empty>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Items that need you">
                {attention.map((a) => (
                  <li key={a.href}>
                    <a href={a.href}>
                      <strong>{a.n}</strong> {a.text}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {runwayLow ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="bad" title="Fee wallet low.">
                  {runway?.toFixed(1)} days of offer updates left, below your threshold of {fees.data?.runway_alert_days} days. <a href="#/offers">See the cost panel</a>
                </Notice>
              </div>
            ) : null}
          </Card>
          <Card title="Alerts" flush>
            {status ? <AlertList alerts={status.alerts} /> : <Empty title="Waiting for the daemon" />}
          </Card>
        </div>

        <Async query={stats} what="the volume">
          {(s) => (
            <div className="cols-2">
              <Card title="Volume by market" flush>
                {s.volume.length === 0 ? (
                  <Empty title="No fills yet" />
                ) : (
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">Market</th>
                        <th scope="col" className="num">
                          XMR
                        </th>
                        <th scope="col" className="num">
                          Asset
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.volume.map((v) => (
                        <tr key={v.market}>
                          <th scope="row">{MARKET_LABEL[v.market]}</th>
                          <td className="num">{fmtXmr(v.xmr, 2)}</td>
                          <td className="num">{fmtMarketAmount(v.market, v.asset, 2)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </Card>
              <Card title="On-chain counters" note="Kept separately by each contract; clients add them up." flush>
                <CounterTable counters={s.counters} />
              </Card>
            </div>
          )}
        </Async>
      </div>
    </>
  );
}

function CounterTable({ counters }: { counters: { chain: ChainName; values: Partial<Record<string, number>> }[] }) {
  const names = [...new Set(counters.flatMap((c) => Object.keys(c.values)))];
  if (names.length === 0) return <Empty title="No counters yet" />;
  return (
    <div className="table-wrap" style={{ maxHeight: 260, overflowY: 'auto' }}>
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">Counter</th>
            {counters.map((c) => (
              <th key={c.chain} scope="col" className="num">
                {chainLabel(c.chain)}
              </th>
            ))}
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {names.map((n) => (
            <tr key={n}>
              <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text)', fontSize: 'inherit', fontWeight: 400 }}>
                {n.replace(/_/g, ' ')}
              </th>
              {counters.map((c) => (
                <td key={c.chain} className="num">
                  {c.values[n] ?? 0}
                </td>
              ))}
              <td className="num">{counters.reduce((t, c) => t + (c.values[n] ?? 0), 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ------------------------------------------------------------------ swaps

const dirLabel = (s: Pick<SwapSummary, 'direction'>): string => DIR_LABEL[s.direction];
/** The approval mode a swap was opened under (`APPROVAL_MODE`). */
export const MODE_NAME: Record<number, string> = { 0: 'auto-accept', 1: 'approval window', 2: 'approved in advance', 3: 'quote on request' };

export function SwapsPage() {
  const [filter, setFilter] = useState<'open' | 'all' | 'settled'>('open');
  const [chain, setChain] = useState<ChainName | ''>('');
  const [state, setState] = useState<SwapStateName | ''>('');
  const query: SwapsQuery = { limit: 200, ...(filter === 'all' ? {} : { open: filter === 'open' }), ...(chain ? { chain } : {}), ...(state ? { state } : {}) };
  const swaps = useQuery('swaps', { body: query }, ['swaps']);
  const id = useId();
  return (
    <>
      <PageHead title="Swaps">Every swap with its state, the next deadline that matters, and the manual actions available right now. Deadlines are chain time.</PageHead>
      <Card
        title="Swaps"
        flush
        actions={
          <>
            <label htmlFor={`${id}-f`} className="muted">
              Show
            </label>
            <select id={`${id}-f`} value={filter} onChange={(e) => setFilter(e.target.value as typeof filter)}>
              <option value="open">Open</option>
              <option value="settled">Settled</option>
              <option value="all">All</option>
            </select>
            <label htmlFor={`${id}-c`} className="muted">
              Chain
            </label>
            <select id={`${id}-c`} value={chain} onChange={(e) => setChain(e.target.value as ChainName | '')}>
              <option value="">Both</option>
              <option value="solana">Solana</option>
              <option value="ethereum">Ethereum</option>
            </select>
            <label htmlFor={`${id}-s`} className="muted">
              State
            </label>
            <select id={`${id}-s`} value={state} onChange={(e) => setState(e.target.value as SwapStateName | '')}>
              <option value="">Any</option>
              {SWAP_STATE_NAMES.filter((s) => s !== 'NONE').map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </>
        }
      >
        <Async query={swaps} what="the swaps">
          {(r) =>
            r.swaps.length === 0 ? (
              <Empty title={filter === 'open' ? 'No open swaps' : 'No swaps match'}>{filter === 'open' ? 'Swaps appear here as soon as a taker locks against one of your offers.' : 'Change the filters to see more.'}</Empty>
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">Swap</th>
                      <th scope="col">State</th>
                      <th scope="col">Market</th>
                      <th scope="col" className="num">
                        XMR
                      </th>
                      <th scope="col" className="num">
                        Amount
                      </th>
                      <th scope="col">Next deadline</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {r.swaps.map((s) => (
                      <tr key={s.ref} className={s.needs_review ? 'attention' : undefined}>
                        <td>
                          <SwapLink swapRef={s.ref} />
                          <div className="muted">
                            {chainLabel(s.chain)} · opened <Time at={s.opened_at} />
                          </div>
                        </td>
                        <td>
                          <StateBadge state={s.state} needsReview={s.needs_review} />
                          <div className="muted">{s.outcome ? s.outcome.replace(/_/g, ' ') : s.phase.replace(/_/g, ' ')}</div>
                          {s.instruction ? (
                            <div data-testid="list-instruction">
                              <Badge tone={s.instruction.status === 'pending' ? 'info' : s.instruction.status === 'refused' ? 'bad' : 'ok'} title={s.instruction.status === 'refused' ? refusalText(s.instruction.reason).why : undefined}>
                                {ACTION_NOUN[s.instruction.action]} {s.instruction.status === 'carried_out' ? 'carried out' : s.instruction.status}
                              </Badge>
                            </div>
                          ) : null}
                        </td>
                        <td>
                          {MARKET_LABEL[s.market]}
                          <div className="muted">
                            {dirLabel(s)}
                            {s.mode !== undefined ? ` · ${MODE_NAME[s.mode] ?? `mode ${s.mode}`}` : ''}
                          </div>
                        </td>
                        <td className="num">{fmtUnits(s.xmr, 12, 4)}</td>
                        <td className="num">
                          {fmtMarketAmount(s.market, s.amount)}
                          {s.deposit !== '0' ? <div className="muted">deposit {fmtMarketAmount(s.market, s.deposit)}</div> : null}
                        </td>
                        <td>
                          {s.next_deadline ? (
                            <>
                              <Countdown to={s.next_deadline.at} chain={s.chain} />
                              <div className="muted">{s.next_deadline.label}</div>
                            </>
                          ) : (
                            <span className="muted">none</span>
                          )}
                        </td>
                        <td className="actions">
                          <SwapActions swap={s} instruction={s.instruction} onDone={swaps.reload} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          }
        </Async>
      </Card>
    </>
  );
}

const DEADLINE_ROWS: { key: keyof SwapDeadlines; label: string; note: string }[] = [
  { key: 't_lock', label: 'Locked', note: 'The taker’s lock (or take) landed' },
  { key: 't_pending_deadline', label: 'Approval window closes', note: 'After this the taker is refunded in full' },
  { key: 't_active', label: 'Approved / active', note: '' },
  { key: 't_note_deadline', label: 'Lock-notice deadline', note: 'A miss is recorded against the party that owed the notice' },
  { key: 't_notice', label: 'Lock notice posted', note: '' },
  { key: 't_cut', label: 'Automatic refund cutoff', note: 'Confirmation time plus 15 minutes' },
  { key: 't_claim_open', label: 'Claim without ready opens', note: 'Your claim delay has passed' },
  { key: 't_ready', label: 'Ready set', note: '' },
  { key: 't_claim_deadline', label: 'Claim deadline', note: 'A miss is recorded against you' },
  { key: 't_refund', label: 'Refunded', note: '' },
  { key: 't_hold', label: 'Deposit hold ends', note: '30 minutes after the refund' },
  { key: 't_split', label: 'Deposit split', note: '60 days after the refund' },
  { key: 't_final', label: 'Final deadline', note: '' },
  { key: 't_exp', label: 'Expiry', note: '30 days after the final deadline' },
  { key: 't_settled', label: 'Settled', note: '' },
];

export function SwapDetailPage({ swapRef }: { swapRef: string }) {
  const swap = useQuery('swap', { params: { ref: swapRef } }, ['swaps', 'inbox']);
  const deposits = useQuery('deposits', undefined, ['swaps']);
  const chainNow = useChainNow();
  return (
    <>
      <PageHead title="Swap" actions={<a href="#/swaps">Back to all swaps</a>}>
        <code style={{ overflowWrap: 'anywhere' }}>{swapRef}</code>
      </PageHead>
      <Async query={swap} what="this swap">
        {(s) => {
          const deposit = deposits.data?.deposits.find((d) => d.ref === s.ref);
          const now = chainNow(s.chain);
          const reload = (): void => {
            swap.reload();
            deposits.reload();
          };
          return (
            <div className="stack">
              {s.needs_review ? (
                <Notice tone="bad" title="Parked for you to review.">
                  {s.last_error ?? 'The daemon stopped acting on this swap.'} The daemon never re-sends on ambiguity; decide below.
                </Notice>
              ) : null}
              {s.instruction ? (
                <div data-testid="instruction" data-status={s.instruction.status}>
                  <InstructionNote instruction={s.instruction} chain={s.chain} />
                </div>
              ) : null}
              <div className="cols-2">
                <Card title="Summary" actions={<SwapActions swap={s} deposit={deposit} instruction={s.instruction} only={['approve', 'reject', 'abort', 'publish-evidence']} onDone={reload} />}>
                  <dl className="kv">
                    <dt>State</dt>
                    <dd>
                      <StateBadge state={s.state} needsReview={s.needs_review} /> <span className="muted">{s.phase.replace(/_/g, ' ')}</span>
                    </dd>
                    <dt>Market</dt>
                    <dd>
                      {MARKET_LABEL[s.market]} · {dirLabel(s)} · {chainLabel(s.chain)}
                    </dd>
                    <dt>Approval mode</dt>
                    <dd>{MODE_NAME[s.mode] ?? `mode ${s.mode}`}</dd>
                    <dt>XMR</dt>
                    <dd>{fmtXmr(s.xmr, 12)}</dd>
                    <dt>Amount</dt>
                    <dd>{fmtMarketAmount(s.market, s.amount, 9)}</dd>
                    <dt>Taker</dt>
                    <dd>
                      <code>{s.taker}</code>
                    </dd>
                    <dt>Depth</dt>
                    <dd>{s.depth} confirmations</dd>
                    {s.next_deadline ? (
                      <>
                        <dt>Next deadline</dt>
                        <dd>
                          <Countdown to={s.next_deadline.at} chain={s.chain} /> <span className="muted">{s.next_deadline.label}</span>
                        </dd>
                      </>
                    ) : null}
                    {s.outcome ? (
                      <>
                        <dt>Outcome</dt>
                        <dd>{s.outcome.replace(/_/g, ' ')}</dd>
                      </>
                    ) : null}
                    {s.last_error && !s.needs_review ? (
                      <>
                        <dt>Last error</dt>
                        <dd>{s.last_error}</dd>
                      </>
                    ) : null}
                  </dl>
                </Card>

                <Card title="Deposit" actions={<SwapActions swap={s} deposit={deposit} instruction={s.instruction} only={['withhold', 'release']} onDone={reload} />}>
                  {deposit ? (
                    <DepositSummary deposit={deposit} />
                  ) : s.deposit === '0' ? (
                    <p className="muted">This swap carries no anti-spam deposit.</p>
                  ) : (
                    <p>
                      {fmtMarketAmount(s.market, s.deposit)} is part of the locked amount. It is held for 30 minutes only if the taker refunds; a withheld deposit never goes to you.
                    </p>
                  )}
                </Card>
              </div>

              <div className="cols-2">
                <Card title="Deadlines" note="Chain time" flush>
                  <table className="tbl">
                    <thead>
                      <tr>
                        <th scope="col">Event</th>
                        <th scope="col">Time (UTC)</th>
                        <th scope="col">From now</th>
                      </tr>
                    </thead>
                    <tbody>
                      {DEADLINE_ROWS.filter((r) => s.deadlines[r.key] !== null).map((r) => {
                        const at = s.deadlines[r.key] as number;
                        return (
                          <tr key={r.key}>
                            <td>
                              {r.label}
                              {r.note ? <div className="muted">{r.note}</div> : null}
                            </td>
                            <td className="mono">{fmtTime(at)}</td>
                            <td>{at <= now ? <span className="muted">passed</span> : <Countdown to={at} chain={s.chain} />}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </Card>
                <div className="stack">
                  <Card title="Monero lock">
                    <dl className="kv">
                      <dt>Lock</dt>
                      <dd>
                        {s.lock_state ? <Badge tone={s.lock_state === 'confirmed' ? 'ok' : s.lock_state === 'invalid' || s.lock_state === 'not-found' ? 'bad' : 'info'}>{s.lock_state}</Badge> : <span className="muted">not sent yet</span>}{' '}
                        {s.lock_confirmations !== null ? (
                          <span>
                            {s.lock_confirmations} of {s.depth} confirmations
                          </span>
                        ) : null}
                      </dd>
                      <dt>Joint address</dt>
                      <dd>
                        <Id value={s.joint_address} head={12} tail={10} />
                      </dd>
                      <dt>Lock transaction</dt>
                      <dd>
                        <Id value={s.lock_txid} head={12} tail={10} />
                      </dd>
                      <dt>Sweep</dt>
                      <dd>
                        <Id value={s.sweep_txid} head={12} tail={10} />
                      </dd>
                      <dt>Evidence</dt>
                      <dd>{s.evidence_published ? 'Published: anyone can verify the lock' : 'Not published'}</dd>
                    </dl>
                  </Card>
                  <Card title="Daemon steps" note="Each money movement is written down before it is sent." flush>
                    {s.intents.length === 0 ? (
                      <Empty title="No steps recorded" />
                    ) : (
                      <table className="tbl">
                        <thead>
                          <tr>
                            <th scope="col">Step</th>
                            <th scope="col">Status</th>
                            <th scope="col">Transaction</th>
                            <th scope="col">When</th>
                          </tr>
                        </thead>
                        <tbody>
                          {s.intents.map((i) => (
                            <tr key={i.id}>
                              <td>{i.kind.replace(/_/g, ' ')}</td>
                              <td>
                                <Badge tone={i.status === 'confirmed' ? 'ok' : i.status === 'failed' || i.status === 'needs_review' ? 'bad' : 'info'}>{i.status.replace(/_/g, ' ')}</Badge>
                              </td>
                              <td>
                                <Id value={i.tx} />
                              </td>
                              <td>
                                <Time at={i.at} />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </Card>
                </div>
              </div>

              <ParkedPayout swapRef={s.ref} chain={s.chain} />

              <Card title="Messages" note="Encrypted messages from this taker about this swap.">
                {s.messages.length === 0 ? <Empty title="No messages about this swap" /> : <MessageThread items={s.messages} swap={s} onChanged={reload} />}
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}

/**
 * A payout the contract could not deliver (a missing or frozen token account, a recipient that
 * rejects ETH) is parked for its owner. Withdrawing it is an owner-key transaction: the daemon
 * builds it, the owner signs it, the daemon relays it.
 */
function ParkedPayout({ swapRef, chain }: { swapRef: string; chain: ChainName }) {
  const client = useClient();
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<{ tone: 'ok' | 'bad' | 'info'; title: string; body: React.ReactNode } | null>(null);
  return (
    <Card title="Parked payout" note="When a payout cannot be delivered at settlement it is parked in the contract instead of failing the swap.">
      <div className="row">
        <Button
          disabled={open}
          onClick={() => {
            setResult(null);
            setOpen(true);
          }}
        >
          Withdraw parked payout
        </Button>
        <span className="muted">Asks the daemon for the withdrawal transaction, which you sign with the owner’s wallet. The daemon never holds that key.</span>
      </div>
      {open ? (
        <OwnerTransaction
          chain={chain}
          build={async () => {
            try {
              return await client.withdrawOwedTx(swapRef);
            } catch (e) {
              // Nothing to withdraw is an answer, not a failure: say so in place and close the panel.
              if (e instanceof ApiFailure && e.code === 'nothing_owed') {
                setOpen(false);
                setResult({ tone: 'info', title: 'Nothing is parked for this swap.', body: 'Every payout of this swap was delivered, or it has already been withdrawn.' });
              }
              throw e;
            }
          }}
          onCancel={() => setOpen(false)}
          onDone={(tx) => {
            setOpen(false);
            setResult(tx.status === 'failed' ? { tone: 'bad', title: 'The withdrawal failed.', body: tx.error ?? 'The chain refused the transaction.' } : { tone: 'ok', title: 'Withdrawn.', body: <TxNotice tx={tx} /> });
          }}
        />
      ) : null}
      {result ? (
        <div style={{ marginTop: 8 }} data-testid="parked-result">
          <Notice tone={result.tone} title={result.title}>
            {result.body}
          </Notice>
        </div>
      ) : null}
    </Card>
  );
}

// ------------------------------------------------------------------ approvals

export function ApprovalsPage() {
  const approvals = useQuery('approvals', undefined, ['swaps']);
  const chainNow = useChainNow();
  return (
    <>
      <PageHead title="Approvals">
        A pending lock waits for you only as long as its window. A missed window refunds the taker in full and shows in your approval rate. Pending locks reserve none of your capacity or one-time keys.
      </PageHead>
      <div className="stack">
        <Card title="Pending locks" note="Soonest deadline first" flush>
          <Async query={approvals} what="the approvals">
            {(a) => {
              const pending = [...a.pending].filter((p) => p.deadline > chainNow(p.chain)).sort((x, y) => x.deadline - y.deadline);
              return pending.length === 0 ? (
                <Empty title="No locks are waiting">Locks against your approval-window offers, and every Ethereum lock, queue here.</Empty>
              ) : (
                <div className="table-wrap">
                  <table className="tbl" aria-label="Pending approvals">
                    <thead>
                      <tr>
                        <th scope="col">Window closes in</th>
                        <th scope="col">Swap</th>
                        <th scope="col">Market</th>
                        <th scope="col" className="num">
                          Size
                        </th>
                        <th scope="col">Your rules say</th>
                        <th scope="col">
                          <span className="sr-only">Decide</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {pending.map((p) => (
                        <tr key={p.ref}>
                          <td>
                            <strong>
                              <Countdown to={p.deadline} chain={p.chain} urgentBelow={20} soonBelow={45} passed="closed" />
                            </strong>
                            <div className="muted">{chainLabel(p.chain)}</div>
                          </td>
                          <td>
                            <SwapLink swapRef={p.ref} />
                            <div className="muted">
                              taker <Id value={p.taker} />
                            </div>
                          </td>
                          <td>
                            {MARKET_LABEL[p.market]}
                            <div className="muted">{DIR_LABEL[p.direction]}</div>
                          </td>
                          <td className="num">
                            {fmtXmr(p.xmr)}
                            <div className="muted">{fmtMarketAmount(p.market, p.amount)}</div>
                          </td>
                          <td>
                            <span className="row" style={{ gap: 4 }}>
                              <Badge tone={p.recommendation === 'approve' ? 'ok' : 'bad'}>{p.recommendation === 'approve' ? 'Approve' : 'Reject'}</Badge>
                              {p.dleq_ok !== null ? <Badge tone={p.dleq_ok ? 'ok' : 'bad'}>{p.dleq_ok ? 'Proof valid' : 'Proof missing or invalid'}</Badge> : null}
                            </span>
                            <ul style={{ margin: '2px 0 0', paddingLeft: 16 }} className="muted">
                              {p.reasons.map((r) => (
                                <li key={r}>{r}</li>
                              ))}
                            </ul>
                          </td>
                          <td className="actions">
                            <SwapActions swap={{ ref: p.ref, actions: ['approve', 'reject'], market: p.market, deposit: '0', chain: p.chain, state: 'PENDING', direction: p.direction, next_deadline: { at: p.deadline, label: '' } }} onDone={approvals.reload} />
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
        <Async query={approvals} what="the advance approvals">
          {(a) => <AdvanceApprovals records={a.advance} epochs={a.epochs} onChanged={approvals.reload} />}
        </Async>
      </div>
    </>
  );
}

function AdvanceApprovals({ records, epochs, onChanged }: { records: AdvanceApprovalRecord[]; epochs: { chain: ChainName; approval_epoch: number; quote_epoch: number }[]; onChanged: () => void }) {
  const client = useClient();
  const { busy, run } = useAction();
  const now = useNow();
  const id = useId();
  const [chain, setChain] = useState<ChainName>('solana');
  const [taker, setTaker] = useState('');
  const [market, setMarket] = useState<Market | ''>('');
  const [direction, setDirection] = useState<'A' | 'B' | ''>('');
  const [maxXmr, setMaxXmr] = useState('');
  const [days, setDays] = useState('30');
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ sig: string; taker: string } | null>(null);

  const issue = async (): Promise<void> => {
    setError(null);
    let max: bigint;
    try {
      max = parseUnits(maxXmr, 12);
    } catch {
      setError('Enter the size limit as an XMR amount, for example 25.');
      return;
    }
    const d = Number(days);
    if (taker.trim() === '') return setError('Enter the taker’s address.');
    if (max <= 0n) return setError('The size limit must be more than 0 XMR.');
    if (!(d > 0)) return setError('Enter how many days the approval is valid.');
    const r = await run(
      'issue',
      () => client.call('approvalsAdvance', { body: { chain, taker: taker.trim(), max_xmr: max.toString(), days: d, ...(market ? { market } : {}), ...(direction ? { direction } : {}) } }),
      'Advance approval signed. Hand the signature to the taker.',
    );
    if (r) {
      setIssued({ sig: r.sig, taker: r.record.taker });
      setTaker('');
      setMaxXmr('');
      onChanged();
    }
  };

  return (
    <Card title="Advance approvals" note="A signed approval for one address, with a size limit per swap and an expiry. The taker presents it when locking and is not kept waiting." flush>
      {records.length === 0 ? (
        <Empty title="No advance approvals issued" />
      ) : (
        <div className="table-wrap">
          <table className="tbl" aria-label="Advance approvals">
            <thead>
              <tr>
                <th scope="col">Taker</th>
                <th scope="col">Chain</th>
                <th scope="col">Scope</th>
                <th scope="col" className="num">
                  Limit per swap
                </th>
                <th scope="col">Expires</th>
                <th scope="col">State</th>
                <th scope="col">
                  <span className="sr-only">Revoke</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((r) => (
                <tr key={`${r.chain}-${r.id}`}>
                  <td>
                    <Id value={r.taker} />
                  </td>
                  <td>{chainLabel(r.chain)}</td>
                  <td>
                    {r.market ? MARKET_LABEL[r.market] : 'Any market'} · {r.direction ? DIR_LABEL[r.direction] : 'either direction'}
                  </td>
                  <td className="num">{fmtXmr(r.max_xmr)}</td>
                  <td>{r.expires_at > now ? <Countdown to={r.expires_at} soonBelow={86_400} urgentBelow={3_600} /> : <span className="muted">{fmtTime(r.expires_at)}</span>}</td>
                  <td>{r.active ? <Badge tone="ok">Active</Badge> : r.expires_at <= now ? <Badge>Expired</Badge> : <Badge tone="warn">Revoked</Badge>}</td>
                  <td className="actions">
                    {r.active && r.chain === 'ethereum' ? (
                      <ConfirmButton
                        label="Revoke"
                        small
                        variant="danger"
                        busy={busy === `revoke:${r.id}`}
                        onConfirm={() => void run(`revoke:${r.id}`, () => client.call('approvalsRevoke', { body: { chain: 'ethereum', id: r.id } }), 'Approval revoked.').then(onChanged)}
                      >
                        Revoke this approval on Ethereum. The taker can no longer lock with it.
                      </ConfirmButton>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
        <h3 className="subhead">Revoke everything</h3>
        <div className="row">
          {epochs.map((e) => (
            <ConfirmButton
              key={e.chain}
              label={`Revoke all on ${chainLabel(e.chain)}`}
              variant="danger"
              small
              busy={busy === `all:${e.chain}`}
              onConfirm={() => void run(`all:${e.chain}`, () => client.call('approvalsRevoke', { body: { chain: e.chain, all: true } }), `Every advance approval on ${chainLabel(e.chain)} is revoked.`).then(onChanged)}
            >
              Bump the approval epoch on {chainLabel(e.chain)} (now {e.approval_epoch}). This kills every outstanding advance approval there at once.
              {e.chain === 'solana' ? ' On Solana this is the only way to revoke.' : ''}
            </ConfirmButton>
          ))}
        </div>

        <h3 className="subhead">Issue an advance approval</h3>
        <form
          className="row"
          style={{ alignItems: 'flex-end', gap: '8px 12px' }}
          onSubmit={(e) => {
            e.preventDefault();
            void issue();
          }}
        >
          <div className="field">
            <label htmlFor={`${id}-chain`}>Chain</label>
            <select id={`${id}-chain`} value={chain} onChange={(e) => setChain(e.target.value as ChainName)}>
              <option value="solana">Solana</option>
              <option value="ethereum">Ethereum</option>
            </select>
          </div>
          <div className="field" style={{ flex: 1, minWidth: 220 }}>
            <label htmlFor={`${id}-taker`}>Taker address</label>
            <input id={`${id}-taker`} type="text" className="w-wide" value={taker} spellCheck={false} onChange={(e) => setTaker(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-market`}>Market</label>
            <select id={`${id}-market`} value={market} onChange={(e) => setMarket(e.target.value as Market | '')}>
              <option value="">Any</option>
              {MARKETS.filter((m) => (chain === 'solana' ? m === 'sol' || m === 'usdc_sol' : m === 'eth' || m === 'usdc_eth')).map((m) => (
                <option key={m} value={m}>
                  {MARKET_LABEL[m]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-dir`}>Direction</label>
            <select id={`${id}-dir`} value={direction} onChange={(e) => setDirection(e.target.value as 'A' | 'B' | '')}>
              <option value="">Either</option>
              <option value="A">{DIR_LABEL.A}</option>
              <option value="B">{DIR_LABEL.B}</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor={`${id}-max`}>Limit per swap (XMR)</label>
            <input id={`${id}-max`} type="text" inputMode="decimal" className="w-num" value={maxXmr} onChange={(e) => setMaxXmr(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor={`${id}-days`}>Valid for (days)</label>
            <input id={`${id}-days`} type="text" inputMode="decimal" className="w-num" value={days} onChange={(e) => setDays(e.target.value)} />
          </div>
          <button type="submit" className="btn primary" disabled={busy === 'issue'}>
            Sign approval
          </button>
        </form>
        {error ? (
          <p className="msg error" role="alert" style={{ marginTop: 6 }}>
            <b>Error:</b> {error}
          </p>
        ) : null}
        {issued ? (
          <div style={{ marginTop: 10 }}>
            <Notice tone="ok" title="Signed.">
              Hand this signature to the taker <Id value={issued.taker} />. It is signed by your operator key; the limit applies to each swap, not to the total.
              <textarea aria-label="Advance approval signature" readOnly rows={2} value={issued.sig} style={{ marginTop: 6 }} />
            </Notice>
          </div>
        ) : null}
      </div>
    </Card>
  );
}

// ------------------------------------------------------------------ deposits

export function DepositsPage() {
  const deposits = useQuery('deposits', undefined, ['swaps', 'inbox']);
  const swaps = useQuery('swaps', { body: { limit: 500 } }, ['swaps']);
  const byRef = useMemo(() => new Map((swaps.data?.swaps ?? []).map((s) => [s.ref, s])), [swaps.data]);
  const reload = (): void => {
    deposits.reload();
    swaps.reload();
  };
  const table = (list: DepositView[], held: boolean) => (
    <div className="table-wrap">
      <table className="tbl" aria-label={held ? 'Held deposits' : 'Withheld deposits'}>
        <thead>
          <tr>
            <th scope="col">Swap</th>
            <th scope="col" className="num">
              Deposit
            </th>
            <th scope="col">{held ? 'Hold ends in' : '60-day split in'}</th>
            <th scope="col">{held ? 'Your policy says' : 'Withheld since'}</th>
            <th scope="col">Taker</th>
            <th scope="col">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {list.map((d) => {
            const s = byRef.get(d.ref);
            return (
              <tr key={d.ref}>
                <td>
                  <SwapLink swapRef={d.ref} />
                  <div className="muted">
                    {MARKET_LABEL[d.market]} · {chainLabel(d.chain)}
                  </div>
                </td>
                <td className="num">{fmtMarketAmount(d.market, d.deposit)}</td>
                <td>
                  {held ? <Countdown to={d.hold_until} chain={d.chain} urgentBelow={300} passed="ended" /> : <Countdown to={d.split_at} chain={d.chain} urgentBelow={86_400} soonBelow={7 * 86_400} passed="due" />}
                  <div className="muted">{held ? 'then it returns to the taker' : 'then half to the taker, half to the treasury'}</div>
                </td>
                <td>
                  {held ? (
                    <>
                      {d.policy_decision === 'withhold' ? <Badge tone="warn">Withhold</Badge> : d.policy_decision === 'release' ? <Badge tone="ok">Let it return</Badge> : <Badge>No decision</Badge>}
                      {d.evidence_required ? <div className="muted">a withhold publishes the lock evidence</div> : null}
                    </>
                  ) : (
                    <Time at={d.refunded_at} />
                  )}
                </td>
                <td>
                  <Id value={d.taker} />
                  {d.release_requested ? (
                    <div>
                      <a href={`#/inbox/${encodeURIComponent(d.ref)}`}>
                        <Badge tone="info">Asked for a release</Badge>
                      </a>
                    </div>
                  ) : null}
                </td>
                <td className="actions">
                  {s ? <SwapActions swap={s} deposit={d} only={['withhold', 'release']} onDone={reload} /> : <SwapActions swap={{ ref: d.ref, actions: held ? ['withhold', 'release'] : ['release'], market: d.market, deposit: d.deposit, chain: d.chain }} deposit={d} onDone={reload} />}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
  return (
    <>
      <PageHead title="Deposits">
        On a refund the anti-spam deposit is held for 30 minutes and then returns to the taker, unless you withhold it. A withheld deposit can never go to you: you can only release it later. After 60 days an unreleased deposit is split, half to the taker and half to the treasury. Your withhold rate is public, and you cannot withhold when you were provably late.
      </PageHead>
      <Async query={deposits} what="the deposits">
        {(r) => {
          const held = r.deposits.filter((d) => d.state === 'held').sort((a, b) => a.hold_until - b.hold_until);
          const withheld = r.deposits.filter((d) => d.state === 'withheld').sort((a, b) => a.split_at - b.split_at);
          return (
            <div className="stack">
              <Card title="Held" note="Inside the 30-minute hold: withhold, release now, or let the hold run out." flush>
                {held.length === 0 ? <Empty title="No deposits are in their hold">A deposit appears here for 30 minutes after a taker refunds.</Empty> : table(held, true)}
              </Card>
              <Card title="Withheld" note="Withheld by you and not yet released." flush>
                {withheld.length === 0 ? <Empty title="No withheld deposits" /> : table(withheld, false)}
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}

// ------------------------------------------------------------------ inbox

interface Thread {
  key: string;
  swapRef: string | null;
  peer: string;
  items: InboxItem[];
  last: number;
  unread: number;
}
export function groupThreads(items: readonly InboxItem[]): Thread[] {
  const map = new Map<string, Thread>();
  for (const m of items) {
    const key = m.swap_ref ?? `peer:${m.peer}`;
    let t = map.get(key);
    if (!t) {
      t = { key, swapRef: m.swap_ref, peer: m.peer, items: [], last: 0, unread: 0 };
      map.set(key, t);
    }
    t.items.push(m);
    t.last = Math.max(t.last, m.at);
    if (m.direction === 'in' && !m.read) t.unread += 1;
  }
  return [...map.values()].sort((a, b) => b.last - a.last);
}

export function InboxPage({ selected }: { selected?: string }) {
  const inbox = useQuery('inbox', undefined, ['inbox']);
  const swaps = useQuery('swaps', { body: { limit: 500 } }, ['swaps']);
  const deposits = useQuery('deposits', undefined, ['swaps']);
  const [picked, setPicked] = useState<string | null>(selected ?? null);
  const reload = (): void => {
    inbox.reload();
    swaps.reload();
    deposits.reload();
  };
  return (
    <>
      <PageHead title="Inbox">
        Encrypted messages from takers, beside the swap they concern and with the matching action to hand. Each message names the key version it was encrypted to; retired keys are kept through their grace period, so messages sent around a rotation still open.
      </PageHead>
      <Async query={inbox} what="the inbox">
        {(r) => {
          const threads = groupThreads(r.items);
          if (threads.length === 0) {
            return (
              <div className="card">
                <Empty title="No messages">Takers reach you here, most often to ask for a withheld deposit to be released before the 60-day split.</Empty>
              </div>
            );
          }
          const current = threads.find((t) => t.key === picked) ?? (threads[0] as Thread);
          const swap = current.swapRef ? swaps.data?.swaps.find((s) => s.ref === current.swapRef) : undefined;
          const deposit = current.swapRef ? deposits.data?.deposits.find((d) => d.ref === current.swapRef) : undefined;
          return (
            <div className="split">
              <Card title="Conversations" note={r.unread === 0 ? 'All read' : `${r.unread} unread`} flush>
                <ul className="thread-list">
                  {threads.map((t) => {
                    const lastMsg = t.items.reduce((a, b) => (a.at > b.at ? a : b));
                    return (
                      <li key={t.key}>
                        <button type="button" aria-current={t.key === current.key ? 'true' : undefined} onClick={() => setPicked(t.key)}>
                          <span className="row" style={{ justifyContent: 'space-between' }}>
                            <strong>{t.swapRef ? `Swap ${t.swapRef.slice(0, 6)}…${t.swapRef.slice(-4)}` : 'No swap'}</strong>
                            {t.unread > 0 ? <span className="count hot">{t.unread}</span> : null}
                          </span>
                          <span className="muted" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {lastMsg.direction === 'out' ? 'You: ' : ''}
                            {lastMsg.text ?? lastMsg.type}
                          </span>
                          <span className="muted">
                            <Time at={t.last} />
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </Card>
              <div className="stack">
                <Card title={current.swapRef ? 'The swap this is about' : 'Not about a swap'} actions={current.swapRef ? <a href={`#/swaps/${encodeURIComponent(current.swapRef)}`}>Open the swap</a> : undefined}>
                  {swap ? (
                    <div className="cols-2">
                      <dl className="kv">
                        <dt>State</dt>
                        <dd>
                          <StateBadge state={swap.state} needsReview={swap.needs_review} />
                        </dd>
                        <dt>Market</dt>
                        <dd>
                          {MARKET_LABEL[swap.market]} · {dirLabel(swap)} · {chainLabel(swap.chain)}
                        </dd>
                        <dt>Size</dt>
                        <dd>
                          {fmtXmr(swap.xmr)} for {fmtMarketAmount(swap.market, swap.amount)}
                        </dd>
                        <dt>Taker</dt>
                        <dd>
                          <Id value={swap.taker} />
                        </dd>
                      </dl>
                      {deposit ? <DepositSummary deposit={deposit} /> : <p className="muted">No deposit is held or withheld on this swap.</p>}
                    </div>
                  ) : current.swapRef ? (
                    <p className="muted">
                      Swap <Id value={current.swapRef} /> is not in the daemon’s list any more.
                    </p>
                  ) : (
                    <p className="muted">
                      From <Id value={current.peer} />. The message names no swap.
                    </p>
                  )}
                </Card>
                <Card title="Messages">
                  <MessageThread key={current.key} items={current.items} swap={swap} onChanged={reload} />
                </Card>
              </div>
            </div>
          );
        }}
      </Async>
    </>
  );
}
