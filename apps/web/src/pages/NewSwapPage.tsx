/** One swap, before the lock: review, the offer's warnings, the recovery file, then the full-screen confirmation (SPEC 8.2 "Swap"). */
import { capsRefusal } from '@xmrswap/protocol';
import { type Pricing, type WatchInfo, isCapReached } from '@xmrswap/sdk';
import { useEffect, useMemo, useState } from 'react';
import { PROGRAM_MISMATCH, type PayoutVerdict } from '../lib/app.js';
import { NOT_OPEN_TITLE, capRefusalText, capsLine, capsState, notOpenText } from '../lib/caps.js';
import { ASSET_LABEL, bpsPercent, formatAsset, formatDuration, formatPrice, formatTime, formatUnits, formatXmrAmount, looksLikeXmrAddress, parseXmr } from '../lib/format.js';
import { lockBlockers } from '../lib/gates.js';
import { expectedSecs, isUsdc, offerWarnings, referenceFor, vsReferenceBps, worstCaseClaimOpen } from '../lib/market.js';
import { WATCHER_CAN, WATCHER_SEES, type WatcherNote, freezeGain, freezeGainText } from '../lib/watcher.js';
import { BackupStep } from '../ui/Backup.js';
import { ConfirmLock } from '../ui/ConfirmLock.js';
import { href, navigate, useApp, useChainNow, useObs, useVault } from '../ui/hooks.js';
import { Copyable, Empty, Field, Notice, SkeletonRows } from '../ui/kit.js';
import { MODE_LABEL, MakerHistory } from './OffersPage.js';

/** Why a payout address is refused or needs a warning, in plain words (SPEC 11.2). */
export function payoutText(v: PayoutVerdict): string | null {
  switch (v.reason) {
    case 'invalid-address':
      return 'This is not an address the proceeds can be paid to. Check it; nothing was sent.';
    case 'token-account':
      return 'This is a token account, not a wallet. The proceeds would follow that account\'s rules and could be stranded. Give the wallet address that owns it instead.';
    case 'program':
      return 'This address is a program, not a wallet. Funds paid to it would follow that program\'s rules and could be lost. Give a wallet address.';
    case 'program-owned':
      return 'This address is controlled by another program, not by a key. It can receive the proceeds only if that program lets it; if it cannot, they stay parked until someone delivers them. Use it only if you know what controls it.';
    default:
      return v.reason ? `This address has code (${v.reason}): if it does not accept the payment, the proceeds stay parked under it until delivered.` : null;
  }
}

type WatcherPick = 'tab' | 'hosted' | 'own';

export function NewSwapPage({ offerId }: { offerId: string }) {
  const app = useApp();
  const registry = useObs(app.registry);
  const settings = useObs(app.settings);
  const wallets = useObs(app.wallets);
  const upgrade = useObs(app.upgrade);
  const build = useObs(app.programBuild);
  const vault = useVault();
  const row = registry.snapshot?.rows.find((r) => r.id === offerId);
  const now = useChainNow(row?.chain ?? 'solana');
  const [xmrText, setXmrText] = useState('');
  const [dest, setDest] = useState('');
  const [payout, setPayout] = useState('');
  const [payoutCheck, setPayoutCheck] = useState<{ for: string; verdict: PayoutVerdict | null; error: string | null } | null>(null);
  const [pick, setPick] = useState<WatcherPick>('tab');
  const [watcher, setWatcher] = useState<{ url: string; info: WatchInfo | null; error: string | null } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalOk, setApprovalOk] = useState<boolean | null>(null);
  const [funding, setFunding] = useState<{ budget: bigint; fee: bigint | null } | null>(null);

  const caps = row ? registry.snapshot?.caps[row.market] : undefined;
  const closed = capsState(caps) === 'closed';
  const xmr = parseXmr(xmrText);
  const priced = useMemo((): { pricing: Pricing | null; error: string | null } => {
    if (!row || xmrText.trim() === '') return { pricing: null, error: null };
    if (xmr === null || xmr === 0n) return { pricing: null, error: 'Type an amount of XMR, for example 1.5.' };
    if (xmr < row.minXmr) return { pricing: null, error: `This offer starts at ${formatXmrAmount(row.minXmr, 6)} XMR.` };
    const max = row.maxXmr < row.capacityXmr ? row.maxXmr : row.capacityXmr;
    if (xmr > max) return { pricing: null, error: `This offer takes at most ${formatXmrAmount(max, 6)} XMR right now. Use the large-swap tool to split a bigger order across makers.` };
    try {
      const pricing = row.price(xmr);
      // The protocol's own limit comes after the maker's: it is a different kind of "no", and is said as such.
      const cap = caps ? capsRefusal(caps, row.direction, pricing.amount, pricing.deposit) : null;
      if (cap && caps) return { pricing: null, error: capRefusalText(cap, caps, row.market, row.direction, { price: (x) => row.price(x), lo: row.minXmr, hi: max }) };
      return { pricing, error: null };
    } catch (e) {
      if (isCapReached(e) && caps) return { pricing: null, error: capRefusalText(e.kind, caps, row.market, row.direction) };
      return { pricing: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [row, xmr, xmrText, caps]);

  const selling = row?.direction === 1;
  const ownAddress = row ? (wallets[row.chain]?.address ?? null) : null;
  const payoutTyped = payout.trim();
  const fresh = selling && payoutTyped !== '' && payoutTyped !== ownAddress;
  // The payout address is read from the chain before the take: an address that is itself a token account or a program is refused.
  useEffect(() => {
    let live = true;
    if (!row || !selling) return;
    // The taking wallet itself needs no check: it already holds the deposit.
    const target = fresh ? payoutTyped : null;
    if (!target) {
      setPayoutCheck(null);
      return;
    }
    setPayoutCheck({ for: target, verdict: null, error: null });
    const t = setTimeout(() => {
      app.checkPayout(row, target).then(
        (verdict) => live && setPayoutCheck({ for: target, verdict, error: null }),
        (e: unknown) => live && setPayoutCheck({ for: target, verdict: null, error: e instanceof Error ? e.message : String(e) }),
      );
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [app, row?.id, selling, payoutTyped, fresh]);
  const verdict = fresh && payoutCheck && payoutCheck.for === payoutTyped ? payoutCheck.verdict : null;
  const tokenRent = verdict && verdict.tokenAccountMissing && row && isUsdc(row.market) ? verdict.tokenAccountRent : 0n;

  useEffect(() => {
    let live = true;
    if (row) void app.sessionFunding(row.chain, row.mode === 2, tokenRent).then((f) => live && setFunding(f));
    return () => {
      live = false;
    };
  }, [app, row?.chain, row?.mode, tokenRent]);
  useEffect(() => {
    let live = true;
    if (row && row.mode === 2 && xmr) void app.approvalUsable(row, xmr).then((ok) => live && setApprovalOk(ok));
    return () => {
      live = false;
    };
  }, [app, row, xmr, wallets.solana]);

  // The watcher option: only where the offer allows a pause and a pause adds time at all.
  const depthForGain = priced.pricing?.depth ?? (row ? (() => { try { return row.depthFor(row.minXmr); } catch { return 2; } })() : 2);
  const gain = row ? freezeGain(row, depthForGain) : null;
  const watcherOffered = !!row && row.direction === 0 && row.freezeWindow > 0 && !!gain?.useful;
  const watcherUrl = pick === 'hosted' ? settings.hostedWatcherUrl : pick === 'own' ? settings.watcherUrl : '';
  useEffect(() => {
    let live = true;
    if (!watcherOffered || pick === 'tab' || !watcherUrl) {
      setWatcher(null);
      return;
    }
    setWatcher({ url: watcherUrl, info: null, error: null });
    app.watcherFor(watcherUrl).then(
      (info) => live && setWatcher({ url: watcherUrl, info, error: null }),
      (e: unknown) => live && setWatcher({ url: watcherUrl, info: null, error: e instanceof Error ? e.message : String(e) }),
    );
    return () => {
      live = false;
    };
  }, [app, watcherOffered, pick, watcherUrl]);

  if (!registry.snapshot) return <SkeletonRows rows={3} />;
  if (!row)
    return (
      <Empty title="This offer is no longer listed">
        <p>The maker withdrew it or it lapsed. Nothing was locked.</p>
        <p className="mt-4">
          <a className="btn btn-primary" href={href()}>
            Back to offers
          </a>
        </p>
      </Empty>
    );

  const buying = row.direction === 0;
  const asset = ASSET_LABEL[row.market];
  const pricing = priced.pricing;
  const ref = referenceFor(row.market, registry.snapshot.rows.filter((r) => r.direction === row.direction), settings);
  const destError = dest.trim() === '' ? null : looksLikeXmrAddress(dest) ? null : 'That does not look like a Monero address (95 or 106 characters).';
  const payoutError = !fresh ? null : payoutCheck?.error ? `The payout address could not be checked: ${payoutCheck.error}` : verdict?.verdict === 'refuse' ? payoutText(verdict) : null;
  const payoutPending = selling && fresh && verdict === null && !payoutCheck?.error;
  const watcherNote: WatcherNote | null = watcherOffered && pick !== 'tab' && watcher?.info ? { url: watcher.url, solana: watcher.info.solana, address: row.chain === 'solana' ? watcher.info.solana : watcher.info.ethereum } : null;
  const watcherError = watcherOffered && pick !== 'tab' ? (!watcherUrl ? 'Set the watcher\'s URL in Settings first.' : (watcher?.error ?? (watcher?.info ? null : 'Asking the watcher who it is…'))) : null;
  const inputError =
    priced.error ??
    (xmrText.trim() === '' ? 'Type the amount of XMR.' : null) ??
    destError ??
    (dest.trim() === '' ? (buying ? 'Give the XMR address that should receive the XMR.' : 'Give an XMR refund address now: your XMR returns there if the swap unwinds.') : null) ??
    payoutError ??
    (payoutPending ? 'Checking the payout address…' : null) ??
    (watcherError ? `Watcher: ${watcherError}` : null);
  const up = upgrade[row.chain];
  const warnings = pricing && xmr ? offerWarnings({ row, pricing, xmr, minDepth: settings.minDepth, upgrade: up }) : [];
  const blockers = [
    ...(closed ? [`${NOT_OPEN_TITLE}: new ${asset} swaps are switched off on-chain for now.`] : []),
    ...(build?.status === 'mismatch' ? [PROGRAM_MISMATCH] : []),
    ...lockBlockers({ backedUp: vault.backedUp, chain: row.chain, walletConnected: wallets[row.chain] !== null, settings, inputError: closed ? null : inputError, offerProblem: row.problem, approvalMissing: row.mode === 2 && approvalOk === false }),
  ];
  const payLabel = pricing ? `${formatAsset(buying ? pricing.amount : pricing.deposit, row.market)} ${asset}` : '';
  const fee = pricing ? pricing.fee : 0n;
  const native = row.chain === 'solana' ? 'SOL' : 'ETH';

  const lock = async () => {
    if (!pricing || !xmr) return;
    setBusy(true);
    setError(null);
    try {
      const refId = await app.openSwap({ row, xmr, destination: dest.trim(), acknowledged: true, ...(fresh ? { payout: payoutTyped } : {}), ...(tokenRent > 0n ? { payoutTokenRent: tokenRent } : {}), ...(watcherNote ? { watcher: watcherNote } : {}) });
      setConfirming(false);
      navigate('swap', refId);
    } catch (e) {
      // The offers and caps are read again when the dialog closes, so the reason stays on screen until the user has read it.
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-8" data-testid="new-swap">
      <header className="grid gap-2">
        <p className="text-sm">
          <a href={href()}>Offers</a> <span className="faint">/</span> {buying ? 'Buy XMR' : 'Sell XMR'}
        </p>
        <h1>
          {buying ? 'Buy XMR with' : 'Sell XMR for'} {asset}
        </h1>
        <p className="muted">
          {formatPrice(row.basePrice, row.market)} per XMR
          {ref ? `, ${Math.abs(vsReferenceBps(row.basePrice, ref.price) / 100).toFixed(2)}% ${vsReferenceBps(row.basePrice, ref.price) >= 0 ? 'above' : 'below'} ${ref.source === 'settings' ? 'your reference' : 'the median offer'}` : ''} · {MODE_LABEL[row.mode]} · maker{' '}
          <a href={href('maker', row.maker.pda)}>{row.maker.pda.slice(0, 8)}…</a>
        </p>
      </header>

      {closed ? (
        <Notice kind="info" title={NOT_OPEN_TITLE} role="status">
          {notOpenText(row.market)}
        </Notice>
      ) : null}

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-12">
        <div className="grid content-start gap-8">
          <section className="grid gap-5" aria-labelledby="amount-h">
            <h2 id="amount-h">1. Amount and address</h2>
            <Field
              label={buying ? 'XMR to buy' : 'XMR to sell'}
              hint={
                <>
                  Between {formatXmrAmount(row.minXmr, 6)} and {formatXmrAmount(row.maxXmr < row.capacityXmr ? row.maxXmr : row.capacityXmr, 6)} XMR.
                  {capsLine(caps, row.market) && !closed ? (
                    <span className="mt-1 block" data-testid="caps-line">
                      {capsLine(caps, row.market)}
                    </span>
                  ) : null}
                </>
              }
              error={closed ? null : priced.error}
            >
              {(p) => <input {...p} className="input input-num" inputMode="decimal" autoComplete="off" placeholder="0.00" value={xmrText} onChange={(e) => setXmrText(e.target.value)} />}
            </Field>
            <Field
              label={buying ? 'Your XMR address' : 'Your XMR refund address'}
              hint={buying ? 'The XMR is swept here by this page. Use an address of a wallet you control.' : 'If the swap unwinds after you paid, your XMR is recovered here. Use an address of a wallet you control.'}
              error={destError}
            >
              {(p) => <input {...p} className="input mono" spellCheck={false} autoComplete="off" value={dest} onChange={(e) => setDest(e.target.value)} />}
            </Field>
            {selling ? (
              <div className="grid gap-3" data-testid="payout">
                <Field
                  label={`Pay the ${asset} to another address (optional)`}
                  hint={
                    <>
                      Left empty, the {asset} is paid to the wallet that takes the offer{ownAddress ? <> ({ownAddress.slice(0, 6)}…)</> : null}. With a fresh address here, an observer cannot link the proceeds to that wallet from the payout transaction alone, and the address needs no balance. It hides nothing else: the address
                      and the amount are public in this swap, and funding the fresh address later from the same wallet links them. It is fixed when you take the offer and cannot be changed; deposits and refunds always return to the taking wallet.
                    </>
                  }
                  error={payoutError}
                >
                  {(p) => <input {...p} className="input mono" spellCheck={false} autoComplete="off" placeholder={ownAddress ?? ''} value={payout} onChange={(e) => setPayout(e.target.value)} />}
                </Field>
                {fresh && verdict?.verdict === 'warn' ? <Notice kind="warn" title="This address is not an ordinary wallet">{payoutText(verdict)}</Notice> : null}
                {tokenRent > 0n ? (
                  <Notice kind="info" title={`This address has no ${asset} account yet`}>
                    The claim creates it, and whoever sends the claim pays for it: {formatUnits(tokenRent, 9, 6)} {native} of account rent. This page's session key sends the claim, so that amount is added to what the lock forwards to it (shown under Session key
                    funding). If the session key cannot pay, the proceeds are not lost: they stay parked for the payout address and anyone can deliver them.
                  </Notice>
                ) : null}
              </div>
            ) : null}
          </section>

          {buying && row.freezeWindow > 0 ? (
            <section className="grid gap-3" aria-labelledby="watch-h" data-testid="watcher-option">
              <h2 id="watch-h">Who watches the swap if this tab closes</h2>
              <p className="muted prose-w">{gain ? freezeGainText(gain, row.freezeWindow) : null}</p>
              {watcherOffered ? (
                <div className="grid gap-3" role="radiogroup" aria-labelledby="watch-h">
                  <label className="check">
                    <input type="radio" name="watcher" checked={pick === 'tab'} onChange={() => setPick('tab')} />
                    <span>
                      <strong>This tab is my watcher</strong> <span className="pill">default</span>
                      <span className="block text-sm muted">Nobody else learns anything. The tab must stay open until it says Safe to close, as on every offer.</span>
                    </span>
                  </label>
                  {settings.hostedWatcherUrl ? (
                    <label className="check">
                      <input type="radio" name="watcher" checked={pick === 'hosted'} onChange={() => setPick('hosted')} />
                      <span>
                        <strong>This site's watcher</strong>
                        <span className="block text-sm muted">{settings.hostedWatcherUrl}</span>
                      </span>
                    </label>
                  ) : null}
                  <label className="check">
                    <input type="radio" name="watcher" checked={pick === 'own'} disabled={!settings.watcherUrl} onChange={() => setPick('own')} />
                    <span>
                      <strong>My own watcher</strong>
                      <span className="block text-sm muted">
                        {settings.watcherUrl ? settings.watcherUrl : (
                          <>
                            Not set. Add its URL in <a href={href('settings')}>Settings</a>.
                          </>
                        )}
                      </span>
                    </span>
                  </label>
                  {pick !== 'tab' ? (
                    <Notice kind="warn" title="What a watcher sees and what it can do" id="watcher-statement">
                      <p>{WATCHER_SEES}</p>
                      <p className="mt-2">{WATCHER_CAN}</p>
                      <p className="mt-2">
                        The swap counts as watched only once the watcher has acknowledged it with its signature; until then the red banner stays and nothing changes. With a watcher you may close the tab earlier, but you must still come back inside the pause to
                        refund, and a refund after a pause can cost your deposit.
                      </p>
                      {watcher?.info ? (
                        <p className="mt-2">
                          Watcher key: <Copyable value={watcherNote!.address} label="watcher key" />
                        </p>
                      ) : null}
                      {watcherError ? <p className="mt-2 font-semibold">{watcherError}</p> : null}
                    </Notice>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}

          <section className="grid gap-3" aria-labelledby="terms-h">
            <h2 id="terms-h">2. What you agree to</h2>
            {pricing && xmr ? (
              warnings.map((w) => (
                <Notice key={w.id} kind="warn" title={w.title} id={`review-warn-${w.id}`}>
                  {w.text}
                </Notice>
              ))
            ) : (
              <p className="muted">Type an amount to see the terms and warnings that apply to this size.</p>
            )}
            {up.frozen === true ? (
              <Notice kind="info" title={`The ${row.chain === 'solana' ? 'Solana program' : 'Ethereum contract'} is immutable`}>
                Its upgrade authority has been given up; nobody can change the rules of this swap.
              </Notice>
            ) : null}
          </section>

          <BackupStep heading="3. Back up your swap keys" />
        </div>

        <aside className="grid content-start gap-5" aria-labelledby="sum-h">
          <div className="panel grid gap-5 p-5 lg:sticky lg:top-24">
            <h2 id="sum-h">Summary</h2>
            <div className="grid gap-4">
              <div className="grid gap-0.5">
                <span className="label">{buying ? 'You lock' : 'You send, from your own Monero wallet'}</span>
                <span className="figure" data-testid="you-pay">
                  {pricing ? (buying ? `${formatAsset(pricing.amount, row.market)} ${asset}` : `${formatXmrAmount(xmr!, 6)} XMR`) : '—'}
                </span>
              </div>
              <div className="grid gap-0.5">
                <span className="label">You receive</span>
                <span className="figure" data-testid="you-receive">
                  {pricing ? (buying ? `${formatXmrAmount(xmr!, 6)} XMR` : `${formatAsset(pricing.amount - fee, row.market)} ${asset}`) : '—'}
                </span>
                <span className="text-sm muted">{buying ? 'Less the Monero network fee of the final sweep.' : `After the 0.05% protocol fee (${pricing ? formatAsset(fee, row.market, 6) : '…'} ${asset}); your deposit comes back with it.`}</span>
              </div>
            </div>
            <hr className="rule" />
            <dl className="kv">
              <dt>Rate</dt>
              <dd className="num">{formatPrice(pricing?.price ?? row.basePrice, row.market)} per XMR</dd>
              <dt>Monero confirmations</dt>
              <dd>{pricing ? pricing.depth : '—'}</dd>
              <dt>Expected duration</dt>
              <dd>{pricing ? `about ${formatDuration(expectedSecs(row, pricing.depth))}` : '—'}</dd>
              <dt>Deposit</dt>
              <dd>{pricing ? (pricing.deposit === 0n ? 'none' : `${formatAsset(pricing.deposit, row.market)} ${asset} (${bpsPercent(row.depBps)})${buying ? ', part of what you lock' : ', posted now'}`) : bpsPercent(row.depBps)}</dd>
              <dt>Maker can claim without you</dt>
              <dd>{formatDuration(row.claimDelay)} after its lock notice</dd>
              <dt>Pause window</dt>
              <dd>{row.freezeWindow === 0 ? 'None: this offer accepts no watcher' : `${formatDuration(row.freezeWindow)}${buying ? (pick === 'tab' ? '; no watcher named' : watcherNote ? '; a watcher will be named' : '') : ' at the maker\'s option'}`}</dd>
              {selling ? (
                <>
                  <dt>Paid to</dt>
                  <dd data-testid="paid-to">{fresh ? <Copyable value={payoutTyped} label="payout address" /> : 'The wallet that takes the offer'}</dd>
                </>
              ) : null}
              <dt>Session key funding</dt>
              <dd>
                {funding ? (
                  <>
                    <span className="num">{formatUnits(funding.budget, row.chain === 'solana' ? 9 : 18, 6)}</span> {native} sent with the lock so this page can {buying ? 'set ready and refund' : 'post the notice and claim'} without your wallet
                    {tokenRent > 0n ? `, including ${formatUnits(tokenRent, 9, 6)} ${native} to create the payout's ${asset} account` : ''}. What it does not spend is swept back to you.
                    {funding.fee !== null ? ` Network fee of the lock: ${formatUnits(funding.fee, 9, 6)} SOL.` : ''}
                  </>
                ) : (
                  'A small amount sent with the lock so this page can act without your wallet; what is left is swept back.'
                )}
              </dd>
              {isUsdc(row.market) ? (
                <>
                  <dt>Asset risk</dt>
                  <dd>USDC can be frozen by its issuer</dd>
                </>
              ) : null}
            </dl>
            <details>
              <summary className="cursor-pointer text-sm font-semibold">This maker's record</summary>
              <div className="mt-2">
                <MakerHistory row={row} />
              </div>
            </details>
            <div className="grid gap-2">
              <button type="button" className="btn btn-primary btn-lg" disabled={blockers.length > 0} aria-describedby="lock-why" onClick={() => setConfirming(true)} data-testid="lock-button">
                {buying ? `Lock ${payLabel || asset}` : `Post deposit ${payLabel}`}
              </button>
              <ul id="lock-why" className="grid gap-1 text-sm muted" aria-live="polite">
                {blockers.length > 0 ? blockers.map((b) => <li key={b}>{b}</li>) : <li>Next: one full-screen confirmation, then your wallet asks you to sign once.</li>}
              </ul>
            </div>
          </div>
        </aside>
      </div>

      {pricing && xmr && now !== null ? (
        <ConfirmLock
          open={confirming}
          action={buying ? `Lock ${payLabel}` : `Post deposit ${payLabel}`}
          summary={buying ? `${payLabel} for ${formatXmrAmount(xmr, 6)} XMR` : `${formatXmrAmount(xmr, 6)} XMR for ${formatAsset(pricing.amount, row.market)} ${asset}`}
          expectedSecs={expectedSecs(row, pricing.depth)}
          deadline={worstCaseClaimOpen(row, now)}
          now={now}
          warnings={warnings}
          large={xmr >= 50_000_000_000_000n}
          busy={busy}
          error={error}
          onConfirm={() => void lock()}
          onClose={() => {
            if (busy) return;
            setConfirming(false);
            if (error) {
              setError(null);
              void app.refreshRegistry();
            }
          }}
        />
      ) : null}
      {now !== null && pricing ? <p className="sr-only">Deadline if everything takes as long as allowed: {formatTime(worstCaseClaimOpen(row, now), now)}</p> : null}
    </div>
  );
}
