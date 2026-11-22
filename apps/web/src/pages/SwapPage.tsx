/** One swap in progress: what state the money is in, the next deadline, and what the tab is doing about it. */
import { MONERO_LOCK_WINDOW, SWAP_STATE } from '@xmrswap/protocol';
import { deadlinesOf, endedInClaim, endedInRefund } from '@xmrswap/sdk';
import { useState } from 'react';
import type { Tracked } from '../lib/engine.js';
import { ASSET_LABEL, formatAsset, formatDuration, formatTime, formatXmrAmount, looksLikeXmrAddress } from '../lib/format.js';
import { marketOf } from '../lib/market.js';
import { LEG_LABEL } from '../lib/orders.js';
import { downloadText } from '../lib/vault.js';
import { href, useApp, useChainNow, useEngine, useVault } from '../ui/hooks.js';
import { Copyable, Countdown, Empty, Field, Notice, Spinner } from '../ui/kit.js';

type StepState = 'done' | 'current' | 'todo';
interface Step {
  title: string;
  state: StepState;
  detail?: React.ReactNode;
}

function Steps({ steps }: { steps: Step[] }) {
  return (
    <ol className="steps" aria-label="Progress">
      {steps.map((s, i) => (
        <li key={s.title} className="step" data-state={s.state} aria-current={s.state === 'current' ? 'step' : undefined}>
          <span className="step-dot" aria-hidden="true">
            {s.state === 'done' ? '✓' : i + 1}
          </span>
          <span className="step-title">
            {s.title}
            <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'current' ? ' (in progress)' : ' (not started)'}</span>
          </span>
          {s.detail ? <div className="step-detail">{s.detail}</div> : null}
        </li>
      ))}
    </ol>
  );
}

const rank = (state: number): number => ({ [SWAP_STATE.PENDING]: 1, [SWAP_STATE.ACTIVE]: 2, [SWAP_STATE.NOTICED]: 3, [SWAP_STATE.READY]: 4 })[state] ?? 5;
const st = (reached: boolean, current: boolean): StepState => (reached ? 'done' : current ? 'current' : 'todo');

const REASON_TEXT: Readonly<Record<string, string>> = {
  'txid-mismatch': 'a node returned a different transaction than the one the maker named',
  'unlock-time': 'the transaction is time-locked, so the XMR could not be moved',
  'rct-type': 'the transaction is of a kind that cannot be verified',
  'commitment-mismatch': 'the amount does not match what the transaction commits to',
  'no-output': 'the transaction pays nothing to the joint address',
  'multiple-outputs': 'the transaction pays the joint address more than once',
  'duplicate-output-key': 'another output uses the same one-time key, so only one of them could ever be spent',
  'double-spend': 'a node has seen a conflicting spend of the same inputs',
};
/** Why the announced lock does not count, in plain words; the node's own wording follows for the record. */
function lockProblem(t: Tracked): string {
  const l = t.lock!;
  const code = l.codes[0] ?? '';
  if (code === 'amount-too-small') return `it pays ${formatXmrAmount(l.amount, 12)} XMR, but this swap needs ${formatXmrAmount(t.view!.xmr, 12)} XMR (amount-too-small)`;
  return REASON_TEXT[code] ? `${REASON_TEXT[code]} (${code})` : (l.reasons[0] ?? 'it failed verification');
}

function LockProgress({ t }: { t: Tracked }) {
  const s = t.view!;
  if (t.noticeOpens === false) return <span>The maker's lock notice does not open. It is treated as no lock: this tab refunds at the cutoff.</span>;
  if (t.lockError) return <span>The lock could not be checked: {t.lockError} Until every node answers and agrees, it counts as not confirmed.</span>;
  if (!t.lock) return <Spinner label="Checking the lock on your Monero nodes" />;
  const conf = Math.min(t.lock.confirmations, s.depth);
  return (
    <div className="grid gap-1.5">
      <span>
        {t.lock.state === 'invalid' ? (
          <strong className="text-danger-text">The lock is not valid: {lockProblem(t)}</strong>
        ) : t.lock.state === 'not-found' ? (
          'Your nodes have not seen the lock transaction yet.'
        ) : t.lock.state === 'pending' ? (
          `Seen in the mempool, ${formatXmrAmount(t.lock.amount)} XMR. Waiting for the first block.`
        ) : (
          <>
            <span className="num">{conf}</span> of <span className="num">{s.depth}</span> confirmations on every node
          </>
        )}
      </span>
      {t.lock.state === 'invalid' ? <span>This tab refunds at the cutoff unless you refund sooner.</span> : <progress className="meter" max={s.depth} value={conf} aria-label={`${conf} of ${s.depth} confirmations`} />}
      {t.lock.reasons.length > 0 && t.lock.state !== 'invalid' ? <span className="text-sm">Not counted as confirmed: {t.lock.reasons[0]}</span> : null}
    </div>
  );
}

function SweepStatus({ t }: { t: Tracked }) {
  const app = useApp();
  const [dest, setDest] = useState('');
  const [confirmExport, setConfirmExport] = useState(false);
  const sw = t.sweep;
  const exportKeys = () => {
    const keys = app.engine.exportKeys(t.ref);
    downloadText(`xmrswap-keys-${t.ref.slice(0, 8)}.json`, JSON.stringify(keys, null, 2));
    setConfirmExport(true);
  };
  return (
    <div className="grid gap-3">
      {t.note.exported ? (
        <Notice kind="safe" title="Keys exported">
          You took the joint wallet's keys. Restore them in Monero wallet software ("restore from keys") to move the XMR.
        </Notice>
      ) : sw.phase === 'confirmed' ? (
        <Notice kind="safe" title="The XMR is in your wallet">
          Sweep <Copyable value={sw.txid} label="sweep transaction id" /> is confirmed.
        </Notice>
      ) : sw.phase === 'broadcast' ? (
        <Notice kind="info" title="Sweep sent, waiting for a block" role="status">
          {t.note.sweepAmount ? `${formatXmrAmount(BigInt(t.note.sweepAmount))} XMR is on its way to your address. ` : ''}Transaction <Copyable value={sw.txid} label="sweep transaction id" />. The page keeps watching until it is mined.
        </Notice>
      ) : sw.phase === 'waiting' ? (
        <Notice kind="safe" title={`The XMR is yours, spendable in ${sw.blocksLeft} block${sw.blocksLeft === 1 ? '' : 's'}`} role="status">
          Monero lets an output move once it is {MONERO_LOCK_WINDOW} blocks deep (about {formatDuration(sw.blocksLeft * 120)}). The page sweeps it to your address then. You can close the tab and come back, or export the keys now.
        </Notice>
      ) : sw.phase === 'building' ? (
        <Spinner label="Building the sweep in this page" />
      ) : sw.phase === 'failed' ? (
        <Notice kind="warn" title="The sweep did not go through. Nothing was spent" role="alert">
          {sw.error} The XMR is still at the joint address and only you hold both keys. The page tries again on its own{sw.attempts > 1 ? ` (${sw.attempts} attempts so far)` : ''}; you can also retry now or export the keys.
        </Notice>
      ) : sw.phase === 'need-destination' ? (
        <form
          className="grid gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (looksLikeXmrAddress(dest)) app.engine.annotate(t.ref, { destination: dest.trim() });
          }}
        >
          <Field label="Your XMR address" hint="The XMR of this swap is yours. Where should it be sent?" error={dest && !looksLikeXmrAddress(dest) ? 'That does not look like a Monero address.' : null}>
            {(p) => <input {...p} className="input mono" value={dest} onChange={(e) => setDest(e.target.value)} spellCheck={false} autoComplete="off" />}
          </Field>
          <button className="btn btn-primary justify-self-start" type="submit" disabled={!looksLikeXmrAddress(dest)}>
            Sweep to this address
          </button>
        </form>
      ) : null}
      {app.engine.canExport(t) && !t.note.sweepConfirmed && !t.note.exported ? (
        <div className="flex flex-wrap items-center gap-3">
          {sw.phase === 'failed' ? (
            <button type="button" className="btn" onClick={() => app.engine.retrySweep(t.ref)}>
              Retry the sweep now
            </button>
          ) : null}
          <button type="button" className="btn" onClick={exportKeys}>
            Export keys
          </button>
          {confirmExport ? (
            <label className="check">
              <input type="checkbox" onChange={(e) => e.target.checked && app.engine.annotate(t.ref, { exported: true })} />
              <span>
                <strong>I saved the key file and will move the XMR myself.</strong>
                <span className="block muted text-sm">The page then stops sweeping and closes the swap account. Without the key file the XMR would be lost.</span>
              </span>
            </label>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function PayXmr({ t, now }: { t: Tracked; now: bigint | null }) {
  const s = t.view!;
  const d = deadlinesOf(s.chain, s);
  if (!t.joint) return <Spinner label="Computing the address" />;
  return (
    <div className="panel grid gap-4 p-4" data-testid="pay-xmr">
      <div className="grid gap-1">
        <span className="label">Send exactly</span>
        <span className="figure">
          {formatXmrAmount(s.xmr, 12)} <span className="text-base font-semibold">XMR</span>
        </span>
      </div>
      <div className="grid gap-1">
        <span className="label">To this address</span>
        <Copyable value={t.joint.address} label="payment address" full />
      </div>
      <div className="grid gap-1">
        <span className="label">Before</span>
        <span>
          <Countdown to={d.tNote!} now={now} className="figure" /> <span className="muted">({formatTime(d.tNote!, now ?? undefined)})</span>
        </span>
      </div>
      <ul className="muted grid list-disc gap-1 pl-5 text-sm">
        <li>Send one transaction for at least the exact amount to exactly this address. Two smaller payments do not count, and anything sent after the time above can cost you your deposit.</li>
        <li>Pay from a wallet you control, not an exchange withdrawal: an exchange may batch, delay or split the payment.</li>
        <li>The page finds the payment by itself, checks it on your nodes and posts the notice. Keep the tab open.</li>
      </ul>
      {t.lockError ? <p className="text-sm text-danger-text">Monero scan problem: {t.lockError}</p> : <Spinner label="Watching for your payment" />}
    </div>
  );
}

export function SwapPage({ swapRef }: { swapRef: string }) {
  const app = useApp();
  const engine = useEngine();
  const vault = useVault();
  const t = engine.swaps.find((x) => x.ref === swapRef);
  const now = useChainNow(t?.chain ?? 'solana');
  const [askCancel, setAskCancel] = useState(false);

  if (!t)
    return engine.ready ? (
      <Empty title="This swap is not known here">
        <p>
          It is not among the swaps of the connected wallet or of the loaded recovery file. Connect the wallet that opened it and load its recovery file, then look in <a href={href('activity')}>Activity</a>.
        </p>
      </Empty>
    ) : (
      <Spinner label="Reading the swap from the chain" />
    );

  const s = t.view;
  const market = t.note.market ?? (s ? marketOf(t.chain, s.asset) : 'sol');
  const asset = ASSET_LABEL[market];
  const amount = s?.amount ?? BigInt(t.note.amount ?? '0');
  const xmr = s?.xmr ?? BigInt(t.note.xmr ?? '0');
  const buying = (s?.direction ?? t.note.direction ?? 0) === 0;
  const d = s ? deadlinesOf(s.chain, s) : null;
  const state = s?.state ?? SWAP_STATE.NONE;
  const r = rank(state);
  const refunded = s ? endedInRefund(s) || state === SWAP_STATE.HOLD || state === SWAP_STATE.WITHHELD : t.leg === 'refunded';
  const claimed = s ? endedInClaim(s) : t.leg === 'swept';
  const waitOn = t.decision?.do === 'wait' ? t.decision.on : null;

  const steps: Step[] = [];
  if (buying) {
    steps.push({ title: `${formatAsset(amount, market)} ${asset} locked in escrow`, state: 'done' });
    if (state === SWAP_STATE.PENDING || (s && s.mode === 1))
      steps.push({
        title: 'Maker approves',
        state: st(r > 1, state === SWAP_STATE.PENDING),
        detail:
          state === SWAP_STATE.PENDING && d ? (
            <>
              Waiting up to <Countdown to={d.tPend!} now={now} />. If the maker rejects or does not answer, everything comes back with no fee. Safe to close meanwhile.
            </>
          ) : undefined,
      });
    steps.push({
      title: 'Maker locks XMR and announces it',
      state: st(r > 2, state === SWAP_STATE.ACTIVE),
      detail:
        state === SWAP_STATE.ACTIVE && d ? (
          <>
            The maker has <Countdown to={d.tNote!} now={now} /> left. If it does not announce a lock by {formatTime(d.tNote!, now ?? undefined)}, this tab collects a full refund.
          </>
        ) : undefined,
    });
    steps.push({ title: `XMR lock reaches ${s?.depth ?? ''} confirmation${s?.depth === 1 ? '' : 's'} on your nodes`, state: st(r > 3, state === SWAP_STATE.NOTICED), detail: state === SWAP_STATE.NOTICED && !refunded ? <LockProgress t={t} /> : undefined });
    steps.push({
      title: 'This tab confirms the lock (ready)',
      state: st(r > 3 && !refunded, waitOn === 'ready-minimum'),
      detail: waitOn === 'ready-minimum' && t.decision?.do === 'wait' && t.decision.until !== null ? <>The lock is confirmed. The contract accepts the confirmation in <Countdown to={t.decision.until} now={now} />.</> : undefined,
    });
    steps.push({
      title: 'Maker takes the payment, which reveals its key',
      state: st(claimed, state === SWAP_STATE.READY),
      detail: state === SWAP_STATE.READY && d ? <>The maker has until {formatTime(d.tCd!, now ?? undefined)}. If it does not, this tab refunds you in full and the miss is recorded against the maker.</> : undefined,
    });
    steps.push({ title: `${formatXmrAmount(xmr)} XMR swept to your address`, state: st(!!t.note.sweepConfirmed || !!t.note.exported, claimed) });
  } else {
    steps.push({ title: `Deposit of ${s ? formatAsset(s.deposit, market) : ''} ${asset} posted`, state: 'done' });
    steps.push({
      title: `Maker escrows ${formatAsset(amount, market)} ${asset}`,
      state: st(r > 1, state === SWAP_STATE.PENDING),
      detail: state === SWAP_STATE.PENDING && d ? <>Waiting up to <Countdown to={d.tPend!} now={now} />. If the maker does not fund, your deposit comes back and the lapse is recorded against it. Safe to close meanwhile.</> : undefined,
    });
    steps.push({ title: 'You pay XMR to the joint address', state: st(r > 2, state === SWAP_STATE.ACTIVE) });
    steps.push({
      title: 'Maker checks your payment and confirms',
      state: st(r > 3, state === SWAP_STATE.NOTICED),
      detail: state === SWAP_STATE.NOTICED ? <>Your payment <Copyable value={t.lockTxid ?? ''} label="payment transaction id" /> was announced. The maker waits for {s!.depth} confirmation{s!.depth === 1 ? '' : 's'}.</> : undefined,
    });
    steps.push({ title: `This tab claims ${asset} for you`, state: st(claimed, state === SWAP_STATE.READY) });
  }

  const heading = buying ? `Buying ${formatXmrAmount(xmr)} XMR for ${formatAsset(amount, market)} ${asset}` : `Selling ${formatXmrAmount(xmr)} XMR for ${formatAsset(amount, market)} ${asset}`;
  const pill = t.atRisk ? <span className="pill pill-risk">At risk: keep this tab open</span> : !s ? <span className="pill">{refunded ? 'Refunded and closed' : 'Complete and closed'}</span> : state === SWAP_STATE.READY ? <span className="pill pill-safe">Ready</span> : <span className="pill">{LEG_LABEL[t.leg]}</span>;
  const canCancel = s !== null && t.keys !== null && !t.note.cancel && ((buying && (state === SWAP_STATE.PENDING || state === SWAP_STATE.ACTIVE || state === SWAP_STATE.NOTICED)) || (!buying && (state === SWAP_STATE.PENDING || state === SWAP_STATE.NOTICED || state === SWAP_STATE.READY)));
  const cancelCosts = state !== SWAP_STATE.PENDING && s !== null && s.deposit > 0n;

  return (
    <div className="grid gap-8" data-testid="swap-page" data-leg={t.leg} data-state={state} data-at-risk={t.atRisk}>
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1>{heading}</h1>
          {pill}
        </div>
        <p className="muted text-sm">
          Swap <Copyable value={t.ref} label="swap reference" /> on {t.chain === 'solana' ? 'Solana' : 'Ethereum'}
          {s ? (
            <>
              {' '}
              with maker <a href={href('maker', s.maker)}>{s.maker.slice(0, 8)}…</a>
            </>
          ) : null}
        </p>
      </header>

      {t.lost ? (
        <Notice kind="danger" title="A deadline passed while this tab was away" role="alert">
          {t.lost}
        </Notice>
      ) : null}
      {t.keys === null && s ? (
        <Notice kind="danger" title="This swap was opened with a different recovery file" role="alert">
          {vault.unlocked ? 'The seed that is loaded does not derive this swap\'s keys.' : 'No recovery seed is loaded.'} This tab cannot refund or collect for it. Load the right file in <a href={href('settings')}>Settings</a>; if a deadline passes first, its funds can be
          lost.
        </Notice>
      ) : null}

      {t.atRisk && t.refundDeadline !== null ? (
        <section className="grid gap-1" aria-label="Refund deadline">
          <span className="label">{state === SWAP_STATE.ACTIVE ? 'Maker must announce its lock within' : 'This tab can still refund for'}</span>
          <Countdown to={t.refundDeadline} now={now} className="figure figure-lg text-danger-text" />
          <span className="muted">
            Until {formatTime(t.refundDeadline, now ?? undefined)} on the chain's clock.
            {state === SWAP_STATE.NOTICED && d ? ` If the lock is not confirmed by ${formatTime(d.tCut!, now ?? undefined)} the tab refunds by itself.` : ''}
          </span>
        </section>
      ) : null}

      <section aria-label="Steps" className="grid gap-4">
        <Steps steps={refunded ? steps.filter((x) => x.state === 'done') : steps} />
        {!buying && state === SWAP_STATE.ACTIVE && s ? t.decision?.do === 'offchain' && t.decision.action === 'show-address' ? <PayXmr t={t} now={now} /> : t.decision?.do === 'wait' && t.decision.warning === 'too-late-to-pay' ? (
          <Notice kind="warn" title="Too little time is left to pay safely">
            The address is not shown with less than three minutes before the notice deadline: a payment that arrives late can cost you your deposit. Do not send XMR. The maker will take its escrow back and your deposit is returned.
          </Notice>
        ) : null : null}
      </section>

      {t.busy ? <Spinner label={`${t.busy}…`} /> : null}
      {t.error ? (
        <Notice kind="warn" title="The last transaction did not go through" role="alert">
          {t.error} The tab retries in a few seconds. Keep it open.
        </Notice>
      ) : null}
      {t.needsWallet && t.decision?.do === 'call' ? (
        <Notice kind="info" title={t.decision.call.name === 'release_deposit' || t.decision.call.name === 'split_deposit' ? 'Your deposit can be collected now' : 'Your wallet is needed for the next step'}>
          <p>
            {t.decision.call.name === 'release_deposit' || t.decision.call.name === 'split_deposit'
              ? 'Returning it takes one small transaction. The session key\'s budget went back to you with the refund, so your wallet pays the fee. Anyone may send it, and it always pays your address; there is no deadline.'
              : 'This step cannot be signed by the session key. Connect the wallet that opened this swap.'}
          </p>
          <button type="button" className="btn mt-3" onClick={() => void app.engine.signWithWallet(t.ref)}>
            Sign with my wallet
          </button>
        </Notice>
      ) : null}

      {refunded ? (
        <section className="grid gap-3" aria-label="Refund">
          <Notice kind="info" title={t.note.autoRefunded ? 'This tab refunded by itself' : s && state === SWAP_STATE.DONE && !s.deposit ? 'Refunded' : 'Refunded'} role="status">
            {t.note.autoRefunded ? 'The Monero lock had not reached the required depth by the safety cutoff, so the tab refunded rather than risk your payment. ' : ''}
            {s && (state === SWAP_STATE.HOLD || state === SWAP_STATE.WITHHELD) ? `${formatAsset(s.amount - s.deposit, market)} ${asset} is back in your wallet.` : `Your ${buying ? `${formatAsset(amount, market)} ${asset}` : 'deposit'} is back in your wallet.`}
          </Notice>
          {s && state === SWAP_STATE.HOLD && d ? (
            <Notice kind="info" title={`Deposit of ${formatAsset(s.deposit, market)} ${asset} is on hold`}>
              It returns in <Countdown to={d.tHold!} now={now} /> unless the maker withholds it. The tab collects it then. The maker can never receive it.
            </Notice>
          ) : null}
          {s && state === SWAP_STATE.WITHHELD && d ? (
            <Notice kind="warn" title={`The maker withheld your deposit of ${formatAsset(s.deposit, market)} ${asset}`}>
              It can only be released back to you. If the maker has not released it by {formatTime(d.tSplit!, now ?? undefined)}, half returns to you and half is lost to the protocol treasury. <a href={href('maker', s.maker)}>Message the maker to ask for a release</a>.
            </Notice>
          ) : null}
        </section>
      ) : null}

      {(buying && claimed) || (!buying && refunded && t.note.paidTxid) ? (
        <section className="grid gap-3" aria-labelledby="sweep-h">
          <h2 id="sweep-h">{buying ? 'Your XMR' : 'Recovering your XMR'}</h2>
          <SweepStatus t={t} />
        </section>
      ) : null}
      {!buying && claimed ? (
        <Notice kind="safe" title="Complete">
          {formatAsset(amount, market)} {asset}, less the 0.05% protocol fee, and your deposit are in your wallet.
        </Notice>
      ) : null}

      {canCancel ? (
        <section className="grid gap-3" aria-label="Cancel">
          {!askCancel ? (
            <button type="button" className="btn btn-danger justify-self-start" onClick={() => setAskCancel(true)}>
              {state === SWAP_STATE.PENDING ? 'Cancel and take everything back' : buying ? 'Refund this swap' : 'Abort this swap'}
            </button>
          ) : (
            <Notice kind="warn" title={state === SWAP_STATE.PENDING ? 'Cancel this pending lock?' : buying ? 'Refund now?' : 'Abort now?'}>
              <p>
                {state === SWAP_STATE.PENDING
                  ? 'Everything comes back to you, with no fee.'
                  : cancelCosts
                    ? `You get ${formatAsset(s!.amount - (buying ? s!.deposit : 0n), market)} ${asset} back now. The deposit of ${formatAsset(s!.deposit, market)} ${asset} is held for 30 minutes; the maker can withhold it for up to 60 days, and then half of it is lost.`
                    : 'Your payment comes back to you.'}
                {!buying && state !== SWAP_STATE.PENDING ? ' The XMR you paid is recovered to your refund address once the maker has taken its escrow back.' : ''}
              </p>
              <div className="mt-3 flex flex-wrap gap-3">
                <button type="button" className="btn btn-danger" onClick={() => app.engine.annotate(t.ref, { cancel: true })}>
                  Yes, {state === SWAP_STATE.PENDING ? 'cancel' : buying ? 'refund' : 'abort'}
                </button>
                <button type="button" className="btn" onClick={() => setAskCancel(false)}>
                  Keep the swap
                </button>
              </div>
            </Notice>
          )}
        </section>
      ) : null}

      <details className="panel p-4">
        <summary className="cursor-pointer font-semibold">Mechanics</summary>
        <dl className="kv mt-4">
          <dt>State on-chain</dt>
          <dd>{s ? `${Object.entries(SWAP_STATE).find(([, v]) => v === state)?.[0] ?? state}` : 'Account closed'}</dd>
          {t.joint ? (
            <>
              <dt>Joint Monero address</dt>
              <dd>
                <Copyable value={t.joint.address} label="joint address" />
              </dd>
            </>
          ) : null}
          {t.lockTxid ? (
            <>
              <dt>Lock transaction</dt>
              <dd>
                <Copyable value={t.lockTxid} label="lock transaction id" />
              </dd>
            </>
          ) : null}
          {t.lock ? (
            <>
              <dt>Nodes</dt>
              <dd>{t.lock.nodes.length === 0 ? `${t.lock.confirmations} confirmations` : t.lock.nodes.map((n) => `${n.url}: ${n.error ? `failed (${n.error})` : `${n.confirmations ?? 0} conf`}`).join('; ')}</dd>
            </>
          ) : null}
          {d && s ? (
            <>
              <dt>Final deadline</dt>
              <dd>{formatTime(d.tFinal, now ?? undefined)}</dd>
              <dt>Session key</dt>
              <dd>
                <Copyable value={s.sessionKey} label="session key" /> (made in this page; it can only set ready, refund or cancel this swap, and a refund always pays your own address)
              </dd>
            </>
          ) : null}
        </dl>
      </details>
    </div>
  );
}
