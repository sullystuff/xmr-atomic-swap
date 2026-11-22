/** The standing banners: red while any leg is at risk, green when it is safe to close (SPEC 8.5 items 3, 5, 6, 8, 9). */
import { CLOCK_SKEW_WARN_SECS } from '@xmrswap/protocol';
import { formatAsset, formatClock, formatTime, ASSET_LABEL, formatDuration } from '../lib/format.js';
import { marketOf } from '../lib/market.js';
import { chainNow, secondsLeft } from '../lib/safety.js';
import { href, useEngine, useGuard, useSafety, useTick, useVault } from './hooks.js';
import { Icon, Notice } from './kit.js';

export function RiskBanner() {
  const engine = useEngine();
  const safety = useSafety();
  const guard = useGuard();
  const now = useTick();
  if (safety.atRisk.length === 0) return null;
  const left = secondsLeft(engine, safety, now);
  const total = safety.atRisk.reduce((sum, t) => sum + (t.view?.amount ?? 0n), 0n);
  const first = safety.atRisk[0]!;
  const market = first.note.market ?? marketOf(first.chain, first.view!.asset);
  const sameAsset = safety.atRisk.every((t) => (t.note.market ?? marketOf(t.chain, t.view!.asset)) === market);
  const stake = sameAsset ? `${formatAsset(total, market)} ${ASSET_LABEL[market]}` : `${safety.atRisk.length} payments`;
  return (
    <div className="banner banner-risk" role="alert" aria-label="Funds at risk" data-testid="risk-banner">
      <div className="banner-inner">
        <span className="banner-title">Do not close this tab</span>
        <span className="banner-clock" role="timer" aria-label={left === null ? 'time left unknown' : `${formatDuration(left)} left to the refund deadline`}>
          {left === null ? '--:--' : formatClock(left)}
        </span>
        <span className="banner-text">
          {stake} {sameAsset ? 'is' : 'are'} locked{safety.atRisk.length > 1 ? ` in ${safety.atRisk.length} swaps` : ''}, and only this tab can refund {safety.atRisk.length === 1 ? 'it' : 'them'}. If you close it, let the computer sleep or lose your connection before the refund deadline, you can lose your funds.{' '}
          {safety.atRisk.length === 1 ? <a href={href('swap', first.ref)}>Show the swap</a> : <a href={href('activity')}>Show the swaps</a>}
          <span className="banner-note">{guard.wakeLock === 'held' ? 'The screen is being kept on.' : 'This browser cannot keep the screen on: turn off sleep yourself.'}</span>
        </span>
      </div>
    </div>
  );
}

export function SafeBanner() {
  const engine = useEngine();
  const safety = useSafety();
  if (!safety.safeToClose) return null;
  const chain = safety.open[0]?.chain ?? 'solana';
  const now = chainNow(engine, chain);
  return (
    <div className="banner banner-safe" role="status" aria-label="Safe to close" data-testid="safe-banner">
      <div className="banner-inner">
        <Icon name="safe" size={28} />
        <span className="banner-title">Safe to close</span>
        <span className="banner-text">
          Every leg is Ready, Claimed or Refunded and your recovery file is saved, so nothing can be lost by closing this tab now.
          {safety.comeBackBefore !== null ? ` If the maker does not complete, come back before ${formatTime(safety.comeBackBefore, now ?? undefined)} to refund.` : ''} Keep it open to collect your XMR as soon as it is yours.
        </span>
      </div>
    </div>
  );
}

/** Page-level notices that are not about one swap: connection alarm, clock skew, a locked vault with swaps open, legs the tab cannot act for. */
export function SystemNotices() {
  const engine = useEngine();
  const safety = useSafety();
  const guard = useGuard();
  const vault = useVault();
  const skew = engine.skewSecs;
  const down = (['solana', 'ethereum', 'monero'] as const).filter((k) => !engine.health[k].ok);
  return (
    <div className="grid gap-3 empty:hidden">
      {guard.alarm ? (
        <Notice kind="danger" title="Connection lost while a swap is at risk" role="alert">
          {guard.alarm}
        </Notice>
      ) : down.length > 0 && safety.open.length > 0 ? (
        <Notice kind="warn" title={`${down.map((d) => (d === 'solana' ? 'Solana' : d === 'ethereum' ? 'Ethereum' : 'Monero')).join(' and ')} connection problem`} role="status">
          {down.map((d) => engine.health[d].error).join(' ')} The page keeps retrying. While a connection is down this tab cannot check locks or refund; if it stays down past a deadline you can lose funds.
        </Notice>
      ) : null}
      {safety.sellOpen.length > 0 ? (
        <Notice kind="warn" title="Keep this tab open while you sell XMR">
          If you close this tab the swap unwinds when the maker refunds; your XMR is recoverable with the recovery file, and your deposit can be withheld.
        </Notice>
      ) : null}
      {!vault.unlocked && safety.open.length > 0 ? (
        <Notice kind="danger" title="Swaps are open but the recovery seed is not loaded" role="alert">
          This tab cannot refund or collect anything until the seed is loaded. If a refund deadline passes first you can lose your funds. <a href={href('settings')}>Load the recovery file or unlock now</a>.
        </Notice>
      ) : safety.blind.length > 0 ? (
        <Notice kind="danger" title="Some swaps were opened with another recovery file" role="alert">
          {safety.blind.length} open swap{safety.blind.length === 1 ? '' : 's'} of this wallet cannot be acted on with the seed that is loaded. Load the recovery file they were made with, or their funds can be lost at the deadline. <a href={href('settings')}>Open Settings</a>.
        </Notice>
      ) : null}
      {skew !== null && Math.abs(skew) > CLOCK_SKEW_WARN_SECS ? (
        <Notice kind="warn" title={`Your computer's clock is ${formatDuration(Math.abs(skew))} ${skew > 0 ? 'ahead of' : 'behind'} the chain`}>
          Every deadline on this site is counted on the chain's clock, not yours, so the times shown are right. Fix your clock so that wallet prompts and other software agree with them.
        </Notice>
      ) : null}
    </div>
  );
}
