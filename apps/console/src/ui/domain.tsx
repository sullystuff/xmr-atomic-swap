/** Pieces that know the product: swap states, manual actions, deposits, message threads, upgrade status. */
import { useId, useState } from 'react';
import { CHAIN_CONSTS, type SwapStateName } from '@xmrswap/protocol';
import type { ChainConnection, DepositView, InboxItem, SwapAction, SwapSummary } from '@xmrswap/protocol/daemon-api';
import { useAction, useClient } from '../api/hooks.js';
import { chainLabel } from '../lib/config/schema.js';
import { MARKET_LABEL, fmtMarketAmount, fmtTime } from '../lib/format.js';
import { Badge, Button, ConfirmButton, Countdown, Id, Notice, Time, type Tone } from './kit.js';

/** Direction from the maker's side (SPEC 0): A = the taker buys XMR, so the maker sells. */
export const DIR_LABEL = { A: 'Sell XMR', B: 'Buy XMR' } as const;

const STATE_TEXT: Record<SwapStateName, { label: string; tone: Tone }> = {
  NONE: { label: 'None', tone: 'plain' },
  PENDING: { label: 'Pending approval', tone: 'accent' },
  ACTIVE: { label: 'Active', tone: 'info' },
  NOTICED: { label: 'XMR lock noticed', tone: 'info' },
  READY: { label: 'Ready', tone: 'ok' },
  ABORTED_FREE: { label: 'Aborted', tone: 'warn' },
  ABORTED_HOLD: { label: 'Aborted, deposit at stake', tone: 'warn' },
  HOLD: { label: 'Deposit held', tone: 'warn' },
  WITHHELD: { label: 'Deposit withheld', tone: 'bad' },
  DONE: { label: 'Done', tone: 'plain' },
};
export function StateBadge({ state, needsReview }: { state: SwapStateName; needsReview?: boolean }) {
  const s = STATE_TEXT[state];
  return (
    <span className="row" style={{ gap: 4 }}>
      <Badge tone={s.tone}>{s.label}</Badge>
      {needsReview ? <Badge tone="bad">Needs review</Badge> : null}
    </span>
  );
}

export function SwapLink({ swapRef }: { swapRef: string }) {
  return (
    <a href={`#/swaps/${encodeURIComponent(swapRef)}`} aria-label={`Swap ${swapRef}`}>
      <Id value={swapRef} />
    </a>
  );
}

export const REJECT_REASONS: { value: 0 | 1 | 2; label: string }[] = [
  { value: 0, label: 'My choice (counts in the approval rate)' },
  { value: 1, label: 'Unusable taker input (no fault)' },
  { value: 2, label: 'The pool leaf was already consumed (no fault)' },
];

const ROUTE_OF: Record<SwapAction, 'swapApprove' | 'swapReject' | 'swapAbort' | 'swapWithhold' | 'swapRelease' | 'swapPublishEvidence'> = {
  approve: 'swapApprove',
  reject: 'swapReject',
  abort: 'swapAbort',
  withhold: 'swapWithhold',
  release: 'swapRelease',
  'publish-evidence': 'swapPublishEvidence',
};
const DONE_TEXT: Record<SwapAction, string> = {
  approve: 'Approved.',
  reject: 'Rejected. The taker is refunded in full.',
  abort: 'Aborted.',
  withhold: 'Deposit withheld.',
  release: 'Deposit released to the taker.',
  'publish-evidence': 'Evidence published.',
};

/** The manual actions the daemon offers for one swap right now, each with its consequence spelled out. */
export function SwapActions({
  swap,
  deposit,
  only,
  onDone,
  small = true,
}: {
  swap: Pick<SwapSummary, 'ref' | 'actions' | 'market' | 'deposit' | 'chain'>;
  deposit?: DepositView | undefined;
  /** Show only these actions (the page decides which belong beside the item). */
  only?: readonly SwapAction[] | undefined;
  onDone?: (() => void) | undefined;
  small?: boolean | undefined;
}) {
  const client = useClient();
  const { busy, run } = useAction();
  const [reason, setReason] = useState<0 | 1 | 2>(0);
  const reasonId = useId();
  const actions = swap.actions.filter((a) => !only || only.includes(a));
  if (actions.length === 0) return null;
  const act = async (a: SwapAction): Promise<void> => {
    const key = `${a}:${swap.ref}`;
    const r = await run(
      key,
      () => (a === 'reject' ? client.call('swapReject', { params: { ref: swap.ref }, body: { reason } }) : client.call(ROUTE_OF[a], { params: { ref: swap.ref } })),
      (res) => res.detail ?? DONE_TEXT[a],
    );
    if (r) onDone?.();
  };
  const isBusy = (a: SwapAction): boolean => busy === `${a}:${swap.ref}`;
  const dep = fmtMarketAmount(swap.market, swap.deposit);
  return (
    <span className="row" style={{ justifyContent: 'flex-end' }}>
      {actions.includes('approve') ? (
        <Button variant="primary" small={small} busy={isBusy('approve')} onClick={() => void act('approve')}>
          Approve
        </Button>
      ) : null}
      {actions.includes('reject') ? (
        <span className="row" style={{ gap: 4 }}>
          <label className="sr-only" htmlFor={reasonId}>
            Reason for rejecting
          </label>
          <select id={reasonId} value={reason} onChange={(e) => setReason(Number(e.target.value) as 0 | 1 | 2)}>
            {REJECT_REASONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <Button variant="danger" small={small} busy={isBusy('reject')} onClick={() => void act('reject')}>
            Reject
          </Button>
        </span>
      ) : null}
      {actions.includes('release') ? (
        <ConfirmButton label="Release deposit" small={small} busy={isBusy('release')} onConfirm={() => void act('release')}>
          Return the deposit of {dep} to the taker now. This cannot be undone.
        </ConfirmButton>
      ) : null}
      {actions.includes('withhold') ? (
        <ConfirmButton label="Withhold deposit" variant="danger" small={small} busy={isBusy('withhold')} onConfirm={() => void act('withhold')}>
          Withhold {dep}. A withheld deposit never goes to you: you can only release it to the taker later, and after 60 days it is split between the taker and the treasury. Your withhold rate is public.
          {deposit?.evidence_required ? ' A lock notice is on record, so the lock evidence is published with it.' : ''}
        </ConfirmButton>
      ) : null}
      {actions.includes('abort') ? (
        <ConfirmButton label="Abort swap" variant="danger" small={small} busy={isBusy('abort')} onConfirm={() => void act('abort')}>
          Abort this swap. The taker gets everything back when it collects, less any deposit you withhold, and the abort is counted in your public history.
        </ConfirmButton>
      ) : null}
      {actions.includes('publish-evidence') ? (
        <ConfirmButton label="Publish evidence" small={small} busy={isBusy('publish-evidence')} onConfirm={() => void act('publish-evidence')}>
          Publish the joint view key and the lock transaction id, so anyone can verify your XMR lock and attribute the abort correctly. This links the swap to its Monero transaction.
        </ConfirmButton>
      ) : null}
    </span>
  );
}

/** What the deposit is doing and what can be done about it. Shown beside the swap. */
export function DepositSummary({ deposit }: { deposit: DepositView }) {
  const held = deposit.state === 'held';
  return (
    <dl className="kv">
      <dt>Deposit</dt>
      <dd>
        {fmtMarketAmount(deposit.market, deposit.deposit)} <Badge tone={held ? 'warn' : 'bad'}>{held ? 'Held' : 'Withheld'}</Badge>
      </dd>
      {held ? (
        <>
          <dt>Hold ends in</dt>
          <dd>
            <Countdown to={deposit.hold_until} chain={deposit.chain} urgentBelow={300} passed="ended; it returns to the taker" />{' '}
            <span className="muted">then it returns to the taker unless withheld</span>
          </dd>
          <dt>Your policy says</dt>
          <dd>{deposit.policy_decision === 'withhold' ? 'Withhold' : deposit.policy_decision === 'release' ? 'Let it return' : 'Nothing to decide'}</dd>
        </>
      ) : (
        <>
          <dt>60-day split in</dt>
          <dd>
            <Countdown to={deposit.split_at} chain={deposit.chain} urgentBelow={86_400} soonBelow={7 * 86_400} passed="due: anyone may split it" />{' '}
            <span className="muted">then half goes to the taker and half to the treasury</span>
          </dd>
        </>
      )}
      <dt>Refunded</dt>
      <dd>{fmtTime(deposit.refunded_at)}</dd>
      {deposit.evidence_required ? (
        <>
          <dt>Evidence</dt>
          <dd>A lock notice is on record: a withhold publishes the lock evidence.</dd>
        </>
      ) : null}
      {deposit.release_requested ? (
        <>
          <dt>Taker</dt>
          <dd>
            <Badge tone="info">Asked for a release</Badge>
          </dd>
        </>
      ) : null}
    </dl>
  );
}

/** One conversation, with the action a message asks for to hand and a reply box. */
export function MessageThread({ items, swap, onChanged }: { items: InboxItem[]; swap?: SwapSummary | undefined; onChanged?: (() => void) | undefined }) {
  const client = useClient();
  const { busy, run } = useAction();
  const [text, setText] = useState('');
  const id = useId();
  const sorted = [...items].sort((a, b) => a.at - b.at);
  const lastIn = [...sorted].reverse().find((m) => m.direction === 'in');
  const unread = sorted.filter((m) => m.direction === 'in' && !m.read);
  const asksRelease = sorted.some((m) => m.direction === 'in' && m.action === 'release_deposit');
  const MAX = 2_000;
  const send = async (): Promise<void> => {
    if (!lastIn) return;
    const r = await run('reply', () => client.call('inboxReply', { params: { id: lastIn.id }, body: { text: text.trim() } }), 'Reply sent, encrypted to the taker’s key.');
    if (r) {
      setText('');
      onChanged?.();
    }
  };
  const markRead = async (): Promise<void> => {
    await run('read', async () => {
      for (const m of unread) await client.call('inboxRead', { params: { id: m.id } });
    });
    onChanged?.();
  };
  return (
    <div className="stack">
      {asksRelease ? (
        swap?.actions.includes('release') ? (
          <Notice tone="info" title="The taker asks you to release the deposit.">
            <span className="row" style={{ marginTop: 6 }}>
              <SwapActions swap={swap} only={['release']} onDone={onChanged} />
            </span>
          </Notice>
        ) : (
          <Notice tone="info" title="The taker asked for the deposit to be released.">
            Nothing is left to release on this swap.
          </Notice>
        )
      ) : null}
      <ol className="thread" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {sorted.map((m) => (
          <li key={m.id} className={`bubble${m.direction === 'out' ? ' out' : ''}`}>
            <header>
              {m.direction === 'in' ? 'Taker' : 'You'} · <Time at={m.at} /> · over {m.transport === 'tor' ? 'Tor' : chainLabel(m.transport)}
              {m.direction === 'in' && !m.read ? (
                <>
                  {' '}
                  · <Badge tone="accent">Unread</Badge>
                </>
              ) : null}
            </header>
            <p style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{m.text ?? <span className="muted">({m.type})</span>}</p>
          </li>
        ))}
      </ol>
      {lastIn ? (
        <form
          className="stack"
          style={{ gap: 6 }}
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor={id} style={{ fontWeight: 600 }}>
            Reply
          </label>
          <textarea id={id} rows={3} value={text} maxLength={MAX} onChange={(e) => setText(e.target.value)} aria-describedby={`${id}-h`} />
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span id={`${id}-h`} className="muted">
              Encrypted to the key the taker sent with its message. {text.length} of {MAX} characters.
            </span>
            <span className="row">
              {unread.length > 0 ? (
                <Button small busy={busy === 'read'} onClick={() => void markRead()}>
                  Mark read
                </Button>
              ) : null}
              <button type="submit" className="btn primary sm" disabled={text.trim() === '' || busy === 'reply'}>
                Send reply
              </button>
            </span>
          </div>
        </form>
      ) : null}
    </div>
  );
}

/** Whether the contracts can still be changed. Stated plainly, never hidden (DESIGN "Upgrades, then immutability"). */
export function upgradeSummary(chains: readonly ChainConnection[]): { tone: 'warn' | 'ok' | 'info'; short: string; text: string } {
  const up = chains.filter((c) => c.upgradeable === true);
  const unknown = chains.filter((c) => c.upgradeable === null);
  const names = (list: readonly ChainConnection[]): string => list.map((c) => chainLabel(c.chain)).join(' and ');
  if (up.length > 0) {
    const both = up.length === chains.length;
    return {
      tone: 'warn',
      short: both ? 'Contracts are still upgradable' : `${names(up)} contract is still upgradable`,
      text: `${both ? 'The contracts are' : `The ${names(up)} contract is`} still upgradable. Whoever holds the upgrade key can change the rules, so you and your takers are trusting them not to.${unknown.length > 0 ? ` The status on ${names(unknown)} could not be read.` : ''}`,
    };
  }
  if (unknown.length > 0) return { tone: 'info', short: 'Upgrade status unknown', text: `Whether the ${names(unknown)} contract can still be upgraded could not be read. Treat it as upgradable until this shows otherwise.` };
  return { tone: 'ok', short: 'Contracts are frozen', text: 'The contracts are frozen: the upgrade authority is revoked on both chains and nobody can change the rules.' };
}

export function UpgradeTable({ chains }: { chains: readonly ChainConnection[] }) {
  return (
    <div className="table-wrap">
      <table className="tbl">
        <thead>
          <tr>
            <th scope="col">Chain</th>
            <th scope="col">Program or contract</th>
            <th scope="col">Can it still be upgraded?</th>
            <th scope="col">Upgrade authority</th>
            <th scope="col">Identity-link delay</th>
          </tr>
        </thead>
        <tbody>
          {chains.map((c) => (
            <tr key={c.chain}>
              <th scope="row">{chainLabel(c.chain)}</th>
              <td>
                <Id value={c.contract} head={10} tail={8} />
              </td>
              <td>{c.upgradeable === true ? <Badge tone="warn">Yes, still upgradable</Badge> : c.upgradeable === false ? <Badge tone="ok">No, frozen</Badge> : <Badge tone="info">Unknown</Badge>}</td>
              <td>{c.upgradeable === false ? <span className="muted">revoked</span> : <Id value={c.upgrade_authority} head={10} tail={8} />}</td>
              <td>{CHAIN_CONSTS[c.chain].linkDelaySecs / 86_400} days</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export const marketLabel = (m: keyof typeof MARKET_LABEL): string => MARKET_LABEL[m];
