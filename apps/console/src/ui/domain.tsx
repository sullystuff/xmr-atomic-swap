/** Pieces that know the product: swap states, manual actions, deposits, message threads, upgrade status. */
import { useId, useState } from 'react';
import { APPROVAL_MODE, type ChainName, type SwapStateName } from '@xmrswap/protocol';
import type { DepositView, InboxItem, SwapAction, SwapSummary } from '@xmrswap/protocol/daemon-api';
import { ApiFailure, describeError } from '../api/client.js';
import { REFUSAL_REASONS, outcomeOf, type ActionOutcome, type ChainConnectionX, type RefusalReason, type SwapInstruction, type UpgradeStatus } from '../api/extensions.js';
import { useAction, useChainNow, useClient, useLive, useToasts } from '../api/hooks.js';
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
  FROZEN: { label: 'Frozen', tone: 'warn' },
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
export const ACTION_NOUN: Record<SwapAction, string> = {
  approve: 'Approval',
  reject: 'Rejection',
  abort: 'Abort',
  withhold: 'Withhold',
  release: 'Release',
  'publish-evidence': 'Evidence publication',
};
const DONE_TEXT: Record<SwapAction, string> = {
  approve: 'Approved. The swap is active and the lock notice is now due.',
  reject: 'Rejected. The taker is refunded in full, with no fee.',
  abort: 'Aborted. The taker gets everything back when it collects, less any deposit you withhold.',
  withhold: 'Deposit withheld. It can only be released to the taker; after 60 days it is split.',
  release: 'Deposit released to the taker.',
  'publish-evidence': 'Evidence published: anyone can now verify the XMR lock.',
};

/** Why an instruction was refused, in plain words, and what happens instead. */
export const REFUSAL_TEXT: Record<RefusalReason, { why: string; instead: string }> = {
  'freeze-not-available': {
    why: 'This swap cannot be paused: it names no watcher, or its offer has no freeze window.',
    instead: 'The swap carries on by its ordinary deadlines.',
  },
  'freeze-window-closed': {
    why: 'The time in which this swap could be paused is over.',
    instead: 'The swap carries on by its ordinary deadlines.',
  },
  'already-frozen': {
    why: 'The swap is already paused, and a swap can be paused only once.',
    instead: 'It stays paused until its frozen-final time, or until the locker sets ready or refunds.',
  },
  'ready-already-set': {
    why: 'The taker has already set ready, so the swap can no longer be backed out of.',
    instead: 'The daemon claims inside the claim window; a missed claim would be recorded against you.',
  },
  'refund-window-closed': {
    why: 'The refund window is over: a refund sent now could land in the taker’s claim window and leak your key share.',
    instead: 'The swap carries on, and the daemon recovers the escrow at the next point the flow allows.',
  },
  'abort-window-closed': {
    why: 'An abort is no longer accepted in the state the swap has reached.',
    instead: 'The swap runs to its end by the normal flow.',
  },
  'already-settled': {
    why: 'The swap is already settled.',
    instead: 'Nothing further happens.',
  },
  'cannot-exit-after-funding': {
    why: 'The escrow is already funded, so this swap can no longer be exited.',
    instead: 'It completes, or expires, by the normal flow.',
  },
  'reject-not-available': {
    why: 'A pending take cannot be rejected on Solana outside window mode.',
    instead: 'Your refusal stays on record: the daemon will not fund this take, and it lapses at the funding deadline, which is recorded as a missed funding.',
  },
  'hold-ended': {
    why: 'The 30-minute hold has ended, so the deposit can no longer be withheld.',
    instead: 'It returns to the taker.',
  },
  'no-deposit-held': {
    why: 'No deposit is held or withheld on this swap.',
    instead: 'There is nothing to withhold or release.',
  },
  'not-available-in-state': {
    why: 'The swap has moved on and is no longer in a state that accepts this.',
    instead: 'Nothing was sent. The swap is shown in its current state.',
  },
  'dry-run': {
    why: 'The daemon is in dry run and sends no transaction.',
    instead: 'Nothing changed. Switch the daemon to live mode to act on swaps.',
  },
};
export function refusalText(reason: string | null | undefined, detail?: string | null): { why: string; instead: string } {
  if (reason && (REFUSAL_REASONS as readonly string[]).includes(reason)) return REFUSAL_TEXT[reason as RefusalReason];
  return { why: detail ?? (reason ? `The daemon refused it (${reason}).` : 'The daemon refused it.'), instead: 'Nothing was sent.' };
}

export interface ActionReport {
  action: SwapAction;
  outcome: ActionOutcome;
  reason: string | null;
  detail: string | null;
  tx: string | null;
}

/** What became of one instruction, shown where it was given. Never silent. */
export function OutcomeNote({ report }: { report: ActionReport }) {
  const noun = ACTION_NOUN[report.action];
  if (report.outcome === 'carried_out') {
    return (
      <div className="notice ok outcome" role="status" data-outcome="carried_out">
        <strong>Carried out.</strong> {DONE_TEXT[report.action]}
        {report.tx ? (
          <>
            {' '}
            Transaction <Id value={report.tx} />.
          </>
        ) : null}
      </div>
    );
  }
  if (report.outcome === 'pending') {
    return (
      <div className="notice info outcome" role="status" data-outcome="pending">
        <strong>On record, not carried out yet.</strong> {noun} waits behind a transaction that is still in flight{report.detail ? ` (${report.detail})` : ''}. It is kept through a restart and shown on the swap until it is carried out or refused; you will get an alert if it is refused.
      </div>
    );
  }
  const t = refusalText(report.reason, report.detail);
  return (
    <div className="notice bad outcome" role="alert" data-outcome="refused" data-reason={report.reason ?? ''}>
      <strong>Not carried out.</strong> {t.why} <span>What happens instead: {t.instead}</span>
    </div>
  );
}

/** Why an action cannot be given right now, when what the console already knows says it would be refused. */
export function blockedReason(
  action: SwapAction,
  ctx: { dryRun: boolean; chainNow: number; swap: Pick<SwapSummary, 'chain' | 'state' | 'direction' | 'next_deadline'> & { mode?: number }; deposit?: DepositView | undefined; instruction?: SwapInstruction | null | undefined },
): string | null {
  const { swap } = ctx;
  if (swap.state === 'DONE') return 'The swap is already settled.';
  if (ctx.instruction?.status === 'pending') return `Your ${ACTION_NOUN[ctx.instruction.action].toLowerCase()} is still waiting to be carried out.`;
  if (ctx.dryRun) return 'Dry run: the daemon sends no transaction.';
  if ((action === 'approve' || action === 'reject') && swap.state === 'PENDING' && swap.next_deadline && ctx.chainNow >= swap.next_deadline.at) return 'The approval window has closed; the taker is refunded in full.';
  if (action === 'reject' && swap.chain === 'solana' && swap.direction === 'B' && swap.mode !== undefined && swap.mode !== APPROVAL_MODE.WINDOW) return 'A take on Solana outside window mode cannot be rejected; left alone, it lapses.';
  if (action === 'withhold' && ctx.deposit && ctx.chainNow >= ctx.deposit.hold_until) return 'The 30-minute hold has ended; the deposit returns to the taker.';
  if (action === 'abort' && swap.state === 'READY') return 'Ready is set; the swap can no longer be backed out of.';
  return null;
}

type ActionSwap = Pick<SwapSummary, 'ref' | 'actions' | 'market' | 'deposit' | 'chain'> & Partial<Pick<SwapSummary, 'state' | 'direction' | 'next_deadline'>> & { mode?: number };

/** The manual actions the daemon offers for one swap right now, each with its consequence spelled out and its outcome shown in place. */
export function SwapActions({
  swap,
  deposit,
  only,
  onDone,
  small = true,
  instruction,
}: {
  swap: ActionSwap;
  deposit?: DepositView | undefined;
  /** Show only these actions (the page decides which belong beside the item). */
  only?: readonly SwapAction[] | undefined;
  onDone?: (() => void) | undefined;
  small?: boolean | undefined;
  /** The swap's instruction on record, when the page has it. */
  instruction?: SwapInstruction | null | undefined;
}) {
  const client = useClient();
  const { status } = useLive();
  const { notify } = useToasts();
  const chainNow = useChainNow();
  const [busy, setBusy] = useState<SwapAction | null>(null);
  const [report, setReport] = useState<ActionReport | null>(null);
  const [reason, setReason] = useState<0 | 1 | 2>(0);
  const reasonId = useId();
  const noteId = useId();
  const actions = swap.actions.filter((a) => !only || only.includes(a));
  if (actions.length === 0 && !report) return null;
  const act = async (a: SwapAction): Promise<void> => {
    setBusy(a);
    setReport(null);
    try {
      const r = a === 'reject' ? await client.call('swapReject', { params: { ref: swap.ref }, body: { reason } }) : await client.call(ROUTE_OF[a], { params: { ref: swap.ref } });
      const outcome = outcomeOf(r);
      setReport({ action: a, outcome, reason: r.refused ?? null, detail: r.detail ?? null, tx: r.tx?.id ?? null });
      // Also announced page-wide, because a row can leave its list once the action lands.
      if (outcome === 'carried_out') notify('ok', DONE_TEXT[a]);
      else if (outcome === 'pending') notify('info', `${ACTION_NOUN[a]} is on record and waits behind a transaction in flight.`);
      else notify('bad', `${ACTION_NOUN[a]} was not carried out. ${refusalText(r.refused, r.detail).why}`);
    } catch (e) {
      // A refusal before anything was recorded: still an outcome, shown in the same place.
      const code = e instanceof ApiFailure ? e.code : '';
      const why = code === 'action_unavailable' ? 'not-available-in-state' : code === 'dry_run' ? 'dry-run' : null;
      setReport({ action: a, outcome: 'refused', reason: why, detail: describeError(e), tx: null });
      notify('bad', `${ACTION_NOUN[a]} was not carried out. ${refusalText(why, describeError(e)).why}`);
    } finally {
      setBusy(null);
      onDone?.();
    }
  };
  const ctx = {
    dryRun: status?.mode === 'dry_run',
    chainNow: chainNow(swap.chain),
    swap: { chain: swap.chain, state: swap.state ?? 'ACTIVE', direction: swap.direction ?? 'A', next_deadline: swap.next_deadline ?? null, ...(swap.mode !== undefined ? { mode: swap.mode } : {}) },
    deposit,
    instruction,
  };
  const blocked = Object.fromEntries(actions.map((a) => [a, blockedReason(a, ctx)])) as Partial<Record<SwapAction, string | null>>;
  const reasons = [...new Set(actions.map((a) => blocked[a]).filter((x): x is string => typeof x === 'string'))];
  const off = (a: SwapAction): boolean => typeof blocked[a] === 'string';
  const dep = fmtMarketAmount(swap.market, swap.deposit);
  return (
    <span className="actions-box">
      <span className="row" style={{ justifyContent: 'flex-end' }}>
        {actions.includes('approve') ? (
          <Button variant="primary" small={small} busy={busy === 'approve'} disabled={off('approve')} aria-describedby={off('approve') ? noteId : undefined} onClick={() => void act('approve')}>
            Approve
          </Button>
        ) : null}
        {actions.includes('reject') ? (
          <span className="row" style={{ gap: 4 }}>
            <label className="sr-only" htmlFor={reasonId}>
              Reason for rejecting
            </label>
            <select id={reasonId} value={reason} disabled={off('reject')} onChange={(e) => setReason(Number(e.target.value) as 0 | 1 | 2)}>
              {REJECT_REASONS.map((r) => (
                <option key={r.value} value={r.value}>
                  {r.label}
                </option>
              ))}
            </select>
            <Button variant="danger" small={small} busy={busy === 'reject'} disabled={off('reject')} aria-describedby={off('reject') ? noteId : undefined} onClick={() => void act('reject')}>
              Reject
            </Button>
          </span>
        ) : null}
        {actions.includes('release') ? (
          <ConfirmButton label="Release deposit" small={small} busy={busy === 'release'} disabled={off('release')} onConfirm={() => void act('release')}>
            Return the deposit of {dep} to the taker now. This cannot be undone.
          </ConfirmButton>
        ) : null}
        {actions.includes('withhold') ? (
          <ConfirmButton label="Withhold deposit" variant="danger" small={small} busy={busy === 'withhold'} disabled={off('withhold')} onConfirm={() => void act('withhold')}>
            Withhold {dep}. A withheld deposit never goes to you: you can only release it to the taker later, and after 60 days it is split between the taker and the treasury. Your withhold rate is public.
            {deposit?.evidence_required ? ' A lock notice is on record, so the lock evidence is published with it.' : ''}
          </ConfirmButton>
        ) : null}
        {actions.includes('abort') ? (
          <ConfirmButton label="Abort swap" variant="danger" small={small} busy={busy === 'abort'} disabled={off('abort')} onConfirm={() => void act('abort')}>
            Abort this swap. The taker gets everything back when it collects, less any deposit you withhold, and the abort is counted in your public history.
          </ConfirmButton>
        ) : null}
        {actions.includes('publish-evidence') ? (
          <ConfirmButton label="Publish evidence" small={small} busy={busy === 'publish-evidence'} disabled={off('publish-evidence')} onConfirm={() => void act('publish-evidence')}>
            Publish the joint view key and the lock transaction id, so anyone can verify your XMR lock and attribute the abort correctly. This links the swap to its Monero transaction.
          </ConfirmButton>
        ) : null}
      </span>
      {reasons.length > 0 ? (
        <span id={noteId} className="blocked muted" data-testid="blocked-reason">
          {reasons.join(' ')}
        </span>
      ) : null}
      {report ? <OutcomeNote report={report} /> : null}
    </span>
  );
}

/** The operator's latest instruction on a swap and what became of it. */
export function InstructionNote({ instruction, chain }: { instruction: SwapInstruction; chain: ChainName }) {
  const noun = ACTION_NOUN[instruction.action];
  const when = (
    <>
      given <Time at={instruction.at} />
    </>
  );
  if (instruction.status === 'pending') {
    return (
      <Notice tone="info" title={`${noun} on record, not carried out yet.`}>
        Your instruction ({when}) waits behind a transaction that is still in flight. The daemon carries it out, or refuses it with the reason, on its next step; it is kept through a restart. Other actions on this swap wait until then.
      </Notice>
    );
  }
  if (instruction.status === 'carried_out') {
    return (
      <Notice tone="ok" title={`${noun} carried out.`}>
        Your instruction ({when}) was carried out{instruction.tx ? ' in transaction ' : ''}
        {instruction.tx ? <Id value={instruction.tx} head={10} tail={8} /> : null} on {chainLabel(chain)}.
      </Notice>
    );
  }
  const t = refusalText(instruction.reason);
  return (
    <Notice tone="bad" title={`${noun} was not carried out.`}>
      Your instruction ({when}) was refused. {t.why} What happens instead: {t.instead}
    </Notice>
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

/** One chain's upgrade state: the daemon's `upgrade_status` when it sends one, else derived from `upgradeable`. */
export function upgradeStateOf(c: ChainConnectionX): UpgradeStatus {
  return c.upgrade_status ?? (c.upgradeable === true ? 'upgradable' : c.upgradeable === false ? 'immutable' : 'unknown');
}
const contractNoun = (c: ChainConnectionX): string => (c.chain === 'solana' ? 'program' : 'contract');

/** One plain sentence per chain: upgradable (and by whom), immutable, or unknown with the reason and when it was last checked. */
export function upgradeLine(c: ChainConnectionX): string {
  const name = chainLabel(c.chain);
  const state = upgradeStateOf(c);
  const checked = c.upgrade_checked_at ? ` Last checked ${fmtTime(c.upgrade_checked_at)}.` : '';
  if (state === 'upgradable') {
    const by = c.upgrade_authority ? ` by ${c.upgrade_authority}` : ' (the authority could not be read)';
    const pending = c.upgrade_pending_authority ? ` A transfer of that authority to ${c.upgrade_pending_authority} is waiting to be accepted.` : '';
    return `${name}: the ${contractNoun(c)} is upgradable${by}.${pending}${checked}`;
  }
  if (state === 'immutable') return `${name}: the ${contractNoun(c)} is immutable; no upgrade authority exists.${checked}`;
  return `${name}: unknown${c.upgrade_reason ? `, because ${c.upgrade_reason}` : ''}. Treat it as upgradable until this shows otherwise.${checked}`;
}

/** Whether the contracts can still be changed. Stated plainly, never hidden (DESIGN "Upgrades, then immutability"). */
export function upgradeSummary(chains: readonly ChainConnectionX[]): { tone: 'warn' | 'ok' | 'info'; short: string; text: string } {
  const up = chains.filter((c) => upgradeStateOf(c) === 'upgradable');
  const unknown = chains.filter((c) => upgradeStateOf(c) === 'unknown');
  const names = (list: readonly ChainConnectionX[]): string => list.map((c) => chainLabel(c.chain)).join(' and ');
  if (chains.length === 0) return { tone: 'info', short: 'Upgrade status unknown', text: 'No chain is connected, so whether the contracts can still be upgraded is unknown. Treat them as upgradable.' };
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

const UPGRADE_BADGE: Record<UpgradeStatus, { tone: Tone; label: string }> = {
  upgradable: { tone: 'warn', label: 'Upgradable' },
  immutable: { tone: 'ok', label: 'Immutable' },
  unknown: { tone: 'info', label: 'Unknown' },
};
export function UpgradeBadge({ chain }: { chain: ChainConnectionX }) {
  const b = UPGRADE_BADGE[upgradeStateOf(chain)];
  return (
    <Badge tone={b.tone} title={upgradeLine(chain)}>
      {chainLabel(chain.chain)}: {b.label.toLowerCase()}
    </Badge>
  );
}

export function UpgradeTable({ chains }: { chains: readonly ChainConnectionX[] }) {
  return (
    <div className="table-wrap">
      <table className="tbl" aria-label="Upgrade status by chain">
        <thead>
          <tr>
            <th scope="col">Chain</th>
            <th scope="col">Program or contract</th>
            <th scope="col">Can it still be upgraded?</th>
            <th scope="col">Upgrade authority</th>
            <th scope="col">Implementation</th>
            <th scope="col">Last checked</th>
          </tr>
        </thead>
        <tbody>
          {chains.map((c) => {
            const state = upgradeStateOf(c);
            return (
              <tr key={c.chain} data-upgrade={state}>
                <th scope="row">{chainLabel(c.chain)}</th>
                <td>
                  <Id value={c.contract} head={10} tail={8} />
                </td>
                <td>
                  {state === 'upgradable' ? <Badge tone="warn">Yes, still upgradable</Badge> : state === 'immutable' ? <Badge tone="ok">No, immutable</Badge> : <Badge tone="info">Unknown</Badge>}
                  {state === 'unknown' ? <div className="muted">{c.upgrade_reason ?? 'the daemon gave no reason'}; treat it as upgradable</div> : null}
                </td>
                <td>
                  {state === 'immutable' ? (
                    <span className="muted">none: revoked</span>
                  ) : c.upgrade_authority ? (
                    <code style={{ overflowWrap: 'anywhere' }}>{c.upgrade_authority}</code>
                  ) : (
                    <span className="muted">not read</span>
                  )}
                  {c.upgrade_pending_authority ? (
                    <div className="msg warning">
                      <b>Transfer waiting:</b> to <code style={{ overflowWrap: 'anywhere' }}>{c.upgrade_pending_authority}</code>
                    </div>
                  ) : null}
                </td>
                <td>
                  <Id value={c.upgrade_implementation} head={10} tail={8} />
                  <div className="muted">{c.chain === 'solana' ? 'ProgramData account' : 'behind the proxy'}</div>
                </td>
                <td>{c.upgrade_checked_at ? <Time at={c.upgrade_checked_at} /> : <span className="muted">not reported</span>}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export const marketLabel = (m: keyof typeof MARKET_LABEL): string => MARKET_LABEL[m];
