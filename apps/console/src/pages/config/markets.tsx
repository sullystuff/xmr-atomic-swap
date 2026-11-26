/** Markets and offers: per-direction switches for all four markets, and every offer setting of DESIGN's table. */
import { useState } from 'react';
import { CHAIN_CONSTS, MARKET_CHAIN, type Market } from '@xmrswap/protocol';
import type { MarketDirection } from '@xmrswap/protocol/daemon-api';
import { APPROVAL_WINDOW_REASON, DIRECTIONS, DIRECTION_LABEL, MARKETS, RECOMMENDED_APPROVAL_SECS, SOURCE_SECTIONS, chainLabel, fieldOf, isPool, offerFields, type FieldDef, type SectionDef } from '../../lib/config/schema.js';
import { getPath } from '../../lib/config/toml.js';
import { canBePending, issuesAt, resolveOffer, type ResolvedOffer } from '../../lib/config/validate.js';
import { MARKET_LABEL } from '../../lib/format.js';
import { Badge, Button, Card, Notice, Switch } from '../../ui/kit.js';
import { Field, Messages, useForm } from './fields.js';

const MARKET_NOTE: Record<Market, { pays: string; prices: string }> = {
  usdc_sol: { pays: 'USDC on Solana', prices: 'XMR/USD' },
  sol: { pays: 'SOL', prices: 'XMR/USD and SOL/USD' },
  usdc_eth: { pays: 'USDC on Ethereum', prices: 'XMR/USD' },
  eth: { pays: 'ETH', prices: 'XMR/USD and ETH/USD' },
};
const poolSectionOf = (name: string): SectionDef => SOURCE_SECTIONS.find((s) => s.path === `pricing.sources.${name}`) as SectionDef;
const MODE_TEXT = { auto: 'auto-accept', window: 'approval window', advance: 'approved in advance' } as const;

function summarise(o: ResolvedOffer): string {
  const dev = typeof o.values.deviation_pct === 'number' ? o.values.deviation_pct : 2;
  const min = typeof o.values.min_xmr === 'number' ? o.values.min_xmr : 0.1;
  const sign = o.direction === 'sell_xmr' ? '+' : '−';
  return `reference ${dev < 0 ? (o.direction === 'sell_xmr' ? '−' : '+') : sign}${Math.abs(dev)}% · ${min} to ${o.maxXmr ?? '?'} XMR · ${MODE_TEXT[o.terms.approval_mode]}`;
}

export function MarketsSection({ blobEndpoint }: { blobEndpoint: boolean | null }) {
  const { draft, set, errors, warnings } = useForm();
  const [open, setOpen] = useState<{ market: Market; direction: MarketDirection } | null>(null);
  const [refused, setRefused] = useState<string | null>(null);

  const toggle = (market: Market, direction: MarketDirection, on: boolean): void => {
    const chain = MARKET_CHAIN[market];
    if (on && chain === 'ethereum' && blobEndpoint === false) {
      // SPEC 8.1: enabling an Ethereum market without a blob endpoint is refused.
      setRefused(`${MARKET_LABEL[market]} ${DIRECTION_LABEL[direction]} was not switched on: Ethereum markets need a blob endpoint in the registry (the onion address or a contact of kind 5), because the taker's proof is too large for any chain. List one on the Registration page first.`);
      return;
    }
    setRefused(null);
    set(`markets.${market}.${direction}.enabled`, on);
    if (on) setOpen({ market, direction });
  };

  return (
    <Card
      id="cfg-markets"
      title="Markets and offers"
      note="Each market switches on or off separately for selling XMR and for buying XMR. Published: enabled markets and size limits go to the registry when they change."
      flush
    >
      {refused ? (
        <div className="card-body">
          <Notice tone="bad" title="Refused.">
            {refused} <a href="#/registration">Open Registration</a>
          </Notice>
        </div>
      ) : null}
      <div className="table-wrap">
        <table className="tbl">
          <thead>
            <tr>
              <th scope="col">Market</th>
              <th scope="col">Enforced by</th>
              <th scope="col">You receive or pay</th>
              {DIRECTIONS.map((d) => (
                <th key={d} scope="col">
                  {DIRECTION_LABEL[d]}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {MARKETS.map((market) => (
              <tr key={market}>
                <th scope="row">{MARKET_LABEL[market]}</th>
                <td>{MARKET_CHAIN[market] === 'solana' ? 'Solana program' : 'Ethereum contract'}</td>
                <td>
                  {MARKET_NOTE[market].pays}
                  <div className="muted">needs {MARKET_NOTE[market].prices}</div>
                </td>
                {DIRECTIONS.map((direction) => {
                  const o = resolveOffer(draft, market, direction, { blobEndpoint });
                  const base = `markets.${market}.${direction}`;
                  const name = `${MARKET_LABEL[market]} ${DIRECTION_LABEL[direction]}`;
                  const nErr = issuesAt(errors, base).length;
                  const nWarn = issuesAt(warnings, base).length;
                  const isOpen = open?.market === market && open.direction === direction;
                  return (
                    <td key={direction}>
                      <div className="row">
                        <Switch label={`${name} enabled`} hideLabel checked={o.wanted} onChange={(v) => toggle(market, direction, v)} />
                        {o.wanted ? o.keptOff.length > 0 ? <Badge tone="warn">Kept off</Badge> : <Badge tone="ok">On</Badge> : <Badge>Off</Badge>}
                        {nErr > 0 ? <Badge tone="bad">{nErr === 1 ? '1 error' : `${nErr} errors`}</Badge> : null}
                        {nErr === 0 && nWarn > 0 ? <Badge tone="warn">{nWarn === 1 ? '1 warning' : `${nWarn} warnings`}</Badge> : null}
                        <Button small variant="ghost" aria-expanded={isOpen} aria-label={`${isOpen ? 'Close' : 'Edit'} ${name} settings`} onClick={() => setOpen(isOpen ? null : { market, direction })}>
                          {isOpen ? 'Close' : 'Edit'}
                        </Button>
                      </div>
                      <div className="muted">{o.wanted ? summarise(o) : 'not offered'}</div>
                      {o.keptOff.length > 0 && o.wanted ? <div className="msg warning">Kept off: {o.keptOff.join('; ')}.</div> : null}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open ? <OfferEditor key={`${open.market}.${open.direction}`} market={open.market} direction={open.direction} blobEndpoint={blobEndpoint} onClose={() => setOpen(null)} /> : null}
    </Card>
  );
}

const GROUPS: { title: string; keys: string[] }[] = [
  { title: 'Price', keys: ['source', 'fallbacks', 'cross_check', 'deviation_pct', 'size_tiers', 'inventory_skew_max_pct', 'volatility_widen'] },
  { title: 'Size and volume', keys: ['min_xmr', 'max_xmr', 'daily_cap_xmr', 'offer_valid_seconds'] },
  { title: 'Approval', keys: ['approval_mode', 'approval_window_seconds'] },
  { title: 'Depth, deadlines and deposit', keys: ['confirmation_depth', 'claim_delay_minutes', 'claim_window_minutes', 'notice_seconds', 'final_days', 'deposit_pct', 'withhold_policy', 'withhold_move_pct'] },
];

function OfferEditor({ market, direction, blobEndpoint, onClose }: { market: Market; direction: MarketDirection; blobEndpoint: boolean | null; onClose: () => void }) {
  const { draft } = useForm();
  const base = `markets.${market}.${direction}`;
  const chain = MARKET_CHAIN[market];
  const c = CHAIN_CONSTS[chain];
  const fields = offerFields(market);
  const byKey = new Map(fields.map((f) => [f.key, f]));
  const o = resolveOffer(draft, market, direction, { blobEndpoint });
  const name = `${MARKET_LABEL[market]} ${DIRECTION_LABEL[direction]}`;
  const window = o.terms.approval_window_secs;
  const waits = canBePending(chain, o.terms.approval_mode);
  const delaySet = getPath(draft, `${base}.claim_delay_minutes`);

  const extra = (f: FieldDef): React.ReactNode => {
    if (f.key === 'approval_window_seconds') {
      return (
        <div style={{ flexBasis: '100%' }}>
          <p className={window > RECOMMENDED_APPROVAL_SECS ? 'msg warning' : 'help'} data-testid="approval-window-advice">
            <b>Strongly recommended: 60 seconds or less.</b> {APPROVAL_WINDOW_REASON}
            {window > RECOMMENDED_APPROVAL_SECS ? ` At ${window} seconds takers see a warning before they lock, stating how long their funds may be held.` : ''}
            {waits ? '' : ' This offer does not wait for approval in its current mode, so the window is not used.'}
          </p>
        </div>
      );
    }
    if (f.key === 'claim_delay_minutes') {
      return (
        <div style={{ flexBasis: '100%' }}>
          <p className="help" data-testid="claim-delay-minimum">
            Minimum implied by the depth in use: <strong>{o.minClaimDelayMinutes} minutes</strong> at depth {o.deepestDepth} on {chainLabel(chain)} (the contract's floor is {c.minClaimDelaySecs / 60}).{' '}
            {delaySet === undefined || delaySet === 'auto' ? `Automatic resolves to ${o.claimDelayMinutes} minutes.` : ''}
          </p>
        </div>
      );
    }
    if (f.key === 'source') {
      return (
        <div style={{ flexBasis: '100%' }}>
          <p className="help">
            Any configured source may be the primary, a fallback or the cross-check; one source alone is a valid setup. A wXMR/USDC pool gives XMR/USD, a wXMR/SOL pool gives XMR/SOL, CoinGecko and CoinMarketCap give every USD price.
          </p>
          {/* An error the daemon puts on the offer as a whole (for example a price it cannot get) belongs beside the source. */}
          <Messages path={base} exact />
          {isPool(o.source) ? (
            <div className="notice warn" role="group" aria-label="Pool protections" style={{ marginTop: 6 }}>
              <strong>The controls that matter most when the pool sets your price.</strong> They apply to every market that uses the pool.
              <div className="fields" style={{ marginTop: 8 }}>
                <Field base={poolSectionOf(o.source).path} def={fieldOf(poolSectionOf(o.source), 'min_liquidity_usd')} />
                <Field base={poolSectionOf(o.source).path} def={fieldOf(poolSectionOf(o.source), 'average_seconds')} />
              </div>
            </div>
          ) : null}
        </div>
      );
    }
    if (f.key === 'deposit_pct') {
      return <span className="unit">of the locked amount, 5% at most</span>;
    }
    return null;
  };

  return (
    <section className="card-body" aria-label={`${name} settings`} style={{ borderTop: '1px solid var(--border)' }}>
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 8 }}>
        <h3>
          {name} <span className="muted">· {chainLabel(chain)}</span>
        </h3>
        <Button small onClick={onClose}>
          Close
        </Button>
      </div>
      <p className="muted" style={{ marginBottom: 10 }}>
        Offer price = reference price × (1 {direction === 'sell_xmr' ? '+' : '−'} deviation {direction === 'sell_xmr' ? '+' : '−'} size tier {direction === 'sell_xmr' ? '+' : '−'} inventory skew). Price source: <strong>{o.source}</strong>
        {o.fallbacks.length > 0 ? <>, then {o.fallbacks.join(', then ')}</> : <>, no fallback</>}
        {o.disagreementApplies ? (
          <>
            , cross-checked against <strong>{o.crossCheck}</strong>
          </>
        ) : (
          <>, no cross-check</>
        )}
        . <span data-testid="disagreement-scope">{o.disagreementApplies ? 'The disagreement pause covers this market.' : 'Disagreement pause: not applicable to this market, since nothing is compared.'}</span>
      </p>
      <Messages path={`${base}.enabled`} exact />
      {GROUPS.map((g) => (
        <div key={g.title}>
          <h4 className="subhead">{g.title}</h4>
          <div className="fields">
            {g.keys.map((k) => {
              const f = byKey.get(k);
              return f ? <Field key={k} base={base} def={f} extra={extra(f)} /> : null;
            })}
          </div>
        </div>
      ))}
    </section>
  );
}
