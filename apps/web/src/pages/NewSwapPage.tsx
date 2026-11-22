/** One swap, before the lock: review, the offer's warnings, the recovery file, then the full-screen confirmation (SPEC 8.2 "Swap"). */
import type { Pricing } from '@xmrswap/sdk';
import { useEffect, useMemo, useState } from 'react';
import { ASSET_LABEL, bpsPercent, formatAsset, formatDuration, formatPrice, formatTime, formatUnits, formatXmrAmount, looksLikeXmrAddress, parseXmr } from '../lib/format.js';
import { lockBlockers } from '../lib/gates.js';
import { expectedSecs, isUsdc, offerWarnings, referenceFor, vsReferenceBps, worstCaseClaimOpen } from '../lib/market.js';
import { BackupStep } from '../ui/Backup.js';
import { ConfirmLock } from '../ui/ConfirmLock.js';
import { href, navigate, useApp, useChainNow, useObs, useVault } from '../ui/hooks.js';
import { Empty, Field, Notice, SkeletonRows } from '../ui/kit.js';
import { MODE_LABEL, MakerHistory } from './OffersPage.js';

export function NewSwapPage({ offerId }: { offerId: string }) {
  const app = useApp();
  const registry = useObs(app.registry);
  const settings = useObs(app.settings);
  const wallets = useObs(app.wallets);
  const upgrade = useObs(app.upgrade);
  const vault = useVault();
  const row = registry.snapshot?.rows.find((r) => r.id === offerId);
  const now = useChainNow(row?.chain ?? 'solana');
  const [xmrText, setXmrText] = useState('');
  const [dest, setDest] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [approvalOk, setApprovalOk] = useState<boolean | null>(null);
  const [funding, setFunding] = useState<{ budget: bigint; fee: bigint | null } | null>(null);
  useEffect(() => {
    let live = true;
    if (row) void app.sessionFunding(row.chain, row.mode === 2).then((f) => live && setFunding(f));
    return () => {
      live = false;
    };
  }, [app, row?.chain, row?.mode]);

  const xmr = parseXmr(xmrText);
  const priced = useMemo((): { pricing: Pricing | null; error: string | null } => {
    if (!row || xmrText.trim() === '') return { pricing: null, error: null };
    if (xmr === null || xmr === 0n) return { pricing: null, error: 'Type an amount of XMR, for example 1.5.' };
    if (xmr < row.minXmr) return { pricing: null, error: `This offer starts at ${formatXmrAmount(row.minXmr, 6)} XMR.` };
    const max = row.maxXmr < row.capacityXmr ? row.maxXmr : row.capacityXmr;
    if (xmr > max) return { pricing: null, error: `This offer takes at most ${formatXmrAmount(max, 6)} XMR right now. Use the large-swap tool to split a bigger order across makers.` };
    try {
      return { pricing: row.price(xmr), error: null };
    } catch (e) {
      return { pricing: null, error: e instanceof Error ? e.message : String(e) };
    }
  }, [row, xmr, xmrText]);

  useEffect(() => {
    let live = true;
    if (row && row.mode === 2 && xmr) void app.approvalUsable(row, xmr).then((ok) => live && setApprovalOk(ok));
    return () => {
      live = false;
    };
  }, [app, row, xmr, wallets.solana]);

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
  const inputError = priced.error ?? (xmrText.trim() === '' ? 'Type the amount of XMR.' : null) ?? destError ?? (dest.trim() === '' ? (buying ? 'Give the XMR address that should receive the XMR.' : 'Give an XMR refund address now: your XMR returns there if the swap unwinds.') : null);
  const up = upgrade[row.chain];
  const warnings = pricing && xmr ? offerWarnings({ row, pricing, xmr, minDepth: settings.minDepth, upgrade: up }) : [];
  const blockers = lockBlockers({ backedUp: vault.backedUp, chain: row.chain, walletConnected: wallets[row.chain] !== null, settings, inputError, offerProblem: row.problem, approvalMissing: row.mode === 2 && approvalOk === false });
  const payLabel = pricing ? `${formatAsset(buying ? pricing.amount : pricing.deposit, row.market)} ${asset}` : '';
  const fee = pricing ? pricing.fee : 0n;

  const lock = async () => {
    if (!pricing || !xmr) return;
    setBusy(true);
    setError(null);
    try {
      const refId = await app.openSwap({ row, xmr, destination: dest.trim(), acknowledged: true });
      setConfirming(false);
      navigate('swap', refId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      void app.refreshRegistry();
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

      <div className="grid gap-8 lg:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)] lg:gap-12">
        <div className="grid content-start gap-8">
          <section className="grid gap-5" aria-labelledby="amount-h">
            <h2 id="amount-h">1. Amount and address</h2>
            <Field label={buying ? 'XMR to buy' : 'XMR to sell'} hint={`Between ${formatXmrAmount(row.minXmr, 6)} and ${formatXmrAmount(row.maxXmr < row.capacityXmr ? row.maxXmr : row.capacityXmr, 6)} XMR.`} error={priced.error}>
              {(p) => <input {...p} className="input input-num" inputMode="decimal" autoComplete="off" placeholder="0.00" value={xmrText} onChange={(e) => setXmrText(e.target.value)} />}
            </Field>
            <Field
              label={buying ? 'Your XMR address' : 'Your XMR refund address'}
              hint={buying ? 'The XMR is swept here by this page. Use an address of a wallet you control.' : 'If the swap unwinds after you paid, your XMR is recovered here. Use an address of a wallet you control.'}
              error={destError}
            >
              {(p) => <input {...p} className="input mono" spellCheck={false} autoComplete="off" value={dest} onChange={(e) => setDest(e.target.value)} />}
            </Field>
          </section>

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

          <BackupStep heading="3. Save your recovery file" />
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
              <dt>Session key funding</dt>
              <dd>
                {funding ? (
                  <>
                    <span className="num">{formatUnits(funding.budget, row.chain === 'solana' ? 9 : 18, 6)}</span> {row.chain === 'solana' ? 'SOL' : 'ETH'} sent with the lock so this page can set ready and refund without your wallet. What it does not spend is swept back to you.
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
          onClose={() => !busy && setConfirming(false)}
        />
      ) : null}
      {now !== null && pricing ? <p className="sr-only">Deadline if everything takes as long as allowed: {formatTime(worstCaseClaimOpen(row, now), now)}</p> : null}
    </div>
  );
}
