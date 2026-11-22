/**
 * The confirmation before locking (SPEC 8.5 item 1): full-screen, plain words, the expected
 * duration and the deadline time, every offer-specific warning with its consequence, and a box
 * that must be ticked. Nothing is sent to the wallet before the box is ticked.
 */
import { useEffect, useId, useState } from 'react';
import { formatDuration, formatTime } from '../lib/format.js';
import { requestNotifications } from '../lib/guard.js';
import type { OfferWarning } from '../lib/market.js';
import { FullscreenDialog, Notice } from './kit.js';

export const CONFIRM_TEXT = 'Keep this tab open until it says Safe to close. If you close it, let the computer sleep or lose your connection before then, you can lose your funds.';

export interface ConfirmLockProps {
  open: boolean;
  /** "Lock 3.00 SOL" */
  action: string;
  /** "3.00 SOL for 2.00 XMR" */
  summary: string;
  expectedSecs: number;
  /** Chain time of the latest moment the maker's claim can open: the tab must stay until Safe to close, at worst until then. */
  deadline: bigint;
  now: bigint;
  warnings: OfferWarning[];
  large?: boolean;
  busy: boolean;
  error: string | null;
  onConfirm: () => void;
  onClose: () => void;
}

export function ConfirmLock(p: ConfirmLockProps) {
  const [ticked, setTicked] = useState(false);
  const h = useId();
  useEffect(() => {
    if (!p.open) setTicked(false);
  }, [p.open]);
  return (
    <FullscreenDialog open={p.open} onClose={p.onClose} labelledBy={h}>
      <div className="mx-auto grid max-w-3xl gap-8 px-4 py-8 sm:py-14" data-testid="confirm-lock">
        <div className="grid gap-4">
          <p className="muted">Before you lock {p.summary}</p>
          <h1 id={h} className="confirm-lead">
            {CONFIRM_TEXT}
          </h1>
        </div>
        <dl className="grid gap-6 sm:grid-cols-2">
          <div className="grid gap-1">
            <dt className="label">Expected duration</dt>
            <dd className="figure m-0">{formatDuration(p.expectedSecs)}</dd>
            <dd className="muted m-0 text-sm">If the maker and the Monero network behave normally.</dd>
          </div>
          <div className="grid gap-1">
            <dt className="label">Stay until Safe to close, at the latest</dt>
            <dd className="figure m-0">{formatTime(p.deadline, p.now)}</dd>
            <dd className="muted m-0 text-sm">After that the maker can take your payment without your confirmation.</dd>
          </div>
        </dl>
        <div className="grid gap-3">
          <h2>What this tab does for you, and what it cannot do</h2>
          <ul className="muted prose-w grid list-disc gap-2 pl-5">
            <li>It checks the maker's Monero lock on your nodes and refunds by itself if the lock does not check out in time. It can only do that while it is open, awake and online.</li>
            <li>Closing the tab, shutting a laptop lid, a phone switching apps, or a dropped connection all count as closing. Nobody else can refund for you: the site and the relay hold no keys.</li>
            <li>The page asks the browser to keep the screen on. {p.large ? 'For a swap this size use a desktop computer on mains power and a wired or stable connection.' : 'A desktop computer on mains power is the safest place to run a swap.'}</li>
            <li>If a connection drops you will hear a sound and get a notification with the time left. Allow notifications when the browser asks.</li>
          </ul>
        </div>
        {p.warnings.length > 0 ? (
          <div className="grid gap-3">
            <h2>About this offer</h2>
            {p.warnings.map((w) => (
              <Notice key={w.id} kind="warn" title={w.title} id={`warn-${w.id}`}>
                {w.text}
              </Notice>
            ))}
          </div>
        ) : null}
        <label className="check">
          <input type="checkbox" checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
          <span>
            <strong>I will keep this tab open, awake and online until it says Safe to close.</strong>
            <span className="block muted text-sm">I understand that if I do not, I can lose my funds.</span>
          </span>
        </label>
        {p.error ? (
          <Notice kind="danger" title="Nothing was locked" role="alert">
            {p.error}
          </Notice>
        ) : null}
        <div className="flex flex-wrap-reverse gap-3">
          <button type="button" className="btn btn-lg" onClick={p.onClose} disabled={p.busy}>
            Go back
          </button>
          <button
            type="button"
            className="btn btn-primary btn-lg"
            disabled={!ticked || p.busy}
            onClick={() => {
              void requestNotifications();
              p.onConfirm();
            }}
          >
            {p.busy ? 'Waiting for your wallet…' : p.action}
          </button>
        </div>
      </div>
    </FullscreenDialog>
  );
}
