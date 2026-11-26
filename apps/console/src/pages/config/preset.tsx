/** The guided "wXMR only" choice: shows what would change and the risks; puts it in the form only when asked, and saves nothing. */
import { useMemo, useState } from 'react';
import { DIRECTION_LABEL, VENUE_LABEL } from '../../lib/config/schema.js';
import { WXMR_ONLY_LABEL, wxmrOnlyPlan } from '../../lib/config/preset.js';
import { diffConfig, type Toml } from '../../lib/config/toml.js';
import { validateConfig } from '../../lib/config/validate.js';
import { MARKET_LABEL } from '../../lib/format.js';
import { Button, Card, Notice } from '../../ui/kit.js';
import { useForm } from './fields.js';

export function WxmrOnlyPreset({ blobEndpoint, onApply }: { blobEndpoint: boolean | null; onApply: (cfg: Toml) => void }) {
  const { draft } = useForm();
  const [open, setOpen] = useState(false);
  const [applied, setApplied] = useState(false);
  const plan = useMemo(() => wxmrOnlyPlan(draft), [draft]);
  const changes = useMemo(() => diffConfig(draft, plan.next), [draft, plan]);
  const warnings = useMemo(() => {
    const v = validateConfig(plan.next, { blobEndpoint, solUsd: null });
    const paths = plan.priced.flatMap((p) => ['source', 'fallbacks', 'cross_check'].map((k) => `markets.${p.market}.${p.direction}.${k}`));
    return v.warnings.filter((w) => paths.includes(w.path)).map((w) => {
      const [, market, direction, field] = w.path.split('.') as [string, keyof typeof MARKET_LABEL, keyof typeof DIRECTION_LABEL, string];
      return { about: `${MARKET_LABEL[market]} ${DIRECTION_LABEL[direction]}, ${field === 'cross_check' ? 'cross-check' : field}`, message: w.message };
    });
  }, [plan, blobEndpoint]);
  const offer = (p: { market: keyof typeof MARKET_LABEL; direction: keyof typeof DIRECTION_LABEL }): string => `${MARKET_LABEL[p.market]} ${DIRECTION_LABEL[p.direction]}`;
  return (
    <Card id="cfg-preset" title="Presets" note="A guided choice changes the form for you. Nothing is saved until you press Validate and save.">
      <div className="row">
        <Button
          aria-expanded={open}
          onClick={() => {
            setApplied(false);
            setOpen((o) => !o);
          }}
        >
          {WXMR_ONLY_LABEL}
        </Button>
        <span className="muted">One source of price, one venue for refills. Everything else in your configuration is left as it is.</span>
      </div>
      {applied ? (
        <div style={{ marginTop: 10 }}>
          <Notice tone="info" title="In the form now, not saved.">
            Review it in the sections below and under Review in the save bar. Nothing reaches the daemon until you press Validate and save; Discard changes takes it back.
          </Notice>
        </div>
      ) : null}
      {open ? (
        <section aria-label="Preset review" className="stack" style={{ marginTop: 12 }}>
          <div>
            <h3 className="subhead">What it does</h3>
            <ul style={{ margin: 0, paddingLeft: 18 }} data-testid="preset-summary">
              {plan.priced.length > 0 ? (
                <li>
                  Prices {plan.priced.map((p) => `${offer(p)} (${p.quote === 'sol' ? 'XMR/SOL' : 'XMR/USD'} from ${p.pool})`).join(', ')} from the pool alone: no fallback, and no cross-check for these markets.
                </li>
              ) : (
                <li>
                  {plan.noPool ? 'No wXMR pool is in your configuration yet: enter its addresses under Price sources first, then come back. ' : ''}No enabled market can be priced from a pool alone (a wXMR/USDC pool prices the USDC markets, a wXMR/SOL pool the SOL market), so no price source changes.
                </li>
              )}
              {plan.untouched.length > 0 ? (
                <li>
                  Leaves {plan.untouched.map((u) => `${offer(u)} (needs ${u.missing.lacks} from another source)`).join(', ')} on the sources they have.
                </li>
              ) : null}
              <li>
                Refills through the wXMR bridge only{plan.venuesSwitchedOff.length > 0 ? `: switches off ${plan.venuesSwitchedOff.map((v) => VENUE_LABEL[v as keyof typeof VENUE_LABEL]).join(', ')}` : ''}, and makes the bridge the whole routing priority.
                {plan.crossChainSwitchedOff ? ' Cross-chain USDC moves are switched off, because they need another venue.' : ''}
              </li>
            </ul>
          </div>
          <div>
            <h3 className="subhead">Risks, for you to weigh</h3>
            {warnings.length === 0 ? (
              <p className="muted">No price source changes, so no new price risk.</p>
            ) : (
              <ul style={{ margin: 0, paddingLeft: 18 }} aria-label="Preset warnings">
                {warnings.map((w, i) => (
                  <li key={i} className="msg warning">
                    <b>{w.about}:</b> {w.message}
                  </li>
                ))}
              </ul>
            )}
            <p className="muted" style={{ marginTop: 4 }}>
              With the bridge as the only venue, a refill waits whenever the bridge is offline or its pools are too thin for your cost limit; nothing else steps in.
            </p>
          </div>
          <div>
            <h3 className="subhead">Changes to your configuration</h3>
            {changes.length === 0 ? (
              <p>Your configuration already matches this setup.</p>
            ) : (
              <table className="tbl" aria-label="Preset changes">
                <thead>
                  <tr>
                    <th scope="col">Key</th>
                    <th scope="col">Now</th>
                    <th scope="col">With the preset</th>
                  </tr>
                </thead>
                <tbody>
                  {changes.map((c) => (
                    <tr key={c.path}>
                      <td className="mono">{c.path}</td>
                      <td className="mono">{c.old ?? <span className="muted">unset</span>}</td>
                      <td className="mono">{c.new ?? <span className="muted">unset</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <div className="row">
            <Button
              variant="primary"
              disabled={changes.length === 0}
              onClick={() => {
                onApply(plan.next);
                setOpen(false);
                setApplied(true);
              }}
            >
              Put these changes in the form
            </Button>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <span className="muted">This does not save. You still press Validate and save.</span>
          </div>
        </section>
      ) : null}
    </Card>
  );
}
