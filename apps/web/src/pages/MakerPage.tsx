/** A maker's profile, linked identity, contact channels and the inbox thread (SPEC 8.2 "Maker"). */
import { CONTACT_KIND, COUNTER_NAMES } from '@xmrswap/protocol';
import { useEffect, useState } from 'react';
import { type Thread, explainSendError } from '../lib/inbox.js';
import { formatDuration, formatPercent } from '../lib/format.js';
import { href, useApp, useEngine, useObs, useVault } from '../ui/hooks.js';
import { Copyable, Empty, Field, Notice, SkeletonRows } from '../ui/kit.js';

export const CONTACT_WARNING = 'Provided by the maker, not verified; nobody legitimate asks for a seed phrase or key share.';
const KIND: Readonly<Record<number, string>> = { [CONTACT_KIND.WEBSITE]: 'Website', [CONTACT_KIND.EMAIL]: 'Email', [CONTACT_KIND.MATRIX]: 'Matrix', [CONTACT_KIND.DISCORD]: 'Discord', [CONTACT_KIND.TELEGRAM]: 'Telegram', [CONTACT_KIND.BLOB_ENDPOINT]: 'Proof endpoint', [CONTACT_KIND.OTHER]: 'Other' };
const SHOWN: readonly (typeof COUNTER_NAMES)[number][] = ['completed', 'approvals', 'rejections', 'rejections_no_fault', 'approval_timeouts', 'missed_notices', 'missed_claims', 'missed_funds', 'claims_without_ready', 'withholds', 'releases', 'splits', 'deposits_returned', 'backouts_post_notice'];
const COUNTER_TEXT: Readonly<Record<string, string>> = {
  completed: 'Completed swaps',
  approvals: 'Approvals',
  rejections: 'Rejections',
  rejections_no_fault: 'Rejections it blames on the taker',
  approval_timeouts: 'Approval windows it let expire',
  missed_notices: 'Missed lock-notice deadlines (fault)',
  missed_claims: 'Missed claim deadlines (fault)',
  missed_funds: 'Takes it did not fund (fault)',
  claims_without_ready: 'Claims without the taker\'s ready',
  withholds: 'Deposits withheld',
  releases: 'Withheld deposits released later',
  splits: 'Withheld deposits split after 60 days',
  deposits_returned: 'Deposits returned',
  backouts_post_notice: 'Backed out after the taker paid XMR',
};

export function MakerPage({ pda }: { pda: string }) {
  const app = useApp();
  const registry = useObs(app.registry);
  const wallets = useObs(app.wallets);
  const vault = useVault();
  const engine = useEngine();
  const maker = registry.snapshot?.makers.find((m) => m.pda === pda);
  const [thread, setThread] = useState<Thread | null>(null);
  const [text, setText] = useState('');
  const [about, setAbout] = useState('');
  const [release, setRelease] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentVia, setSentVia] = useState<string | null>(null);
  const [approval, setApproval] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    if (maker && vault.unlocked) void app.refreshThread(maker).then((t) => live && setThread(t), () => undefined);
    return () => {
      live = false;
    };
  }, [app, maker, vault.unlocked, wallets.solana]);

  if (!registry.snapshot) return <SkeletonRows rows={4} />;
  if (!maker)
    return (
      <Empty title="This maker is not in the registry">
        <p>
          No maker account exists at <code>{pda}</code> on the configured Solana program.
        </p>
      </Empty>
    );
  const rep = maker.identity.reputation;
  const swaps = engine.swaps.filter((t) => t.view?.maker === pda || t.view?.maker.toLowerCase() === maker.ethereum?.address.toLowerCase());
  const link = maker.identity.link;
  const rows = registry.snapshot.rows.filter((r) => r.maker.pda === pda);
  const contacts = maker.solana.contacts.filter((c) => c.value);

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await app.sendMessage(maker, text, swaps.find((t) => t.ref === about), release ? 'release_deposit' : undefined);
      setThread(r.thread);
      setSentVia(r.via);
      setText('');
      setRelease(false);
    } catch (e) {
      setError(explainSendError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="grid gap-10">
      <header className="grid gap-2">
        <p className="text-sm">
          <a href={href()}>Offers</a> <span className="faint">/</span> maker
        </p>
        <h1>
          Maker <span className="mono">{pda.slice(0, 8)}…</span>
        </h1>
        <p className="muted">
          {rows.length} live offer{rows.length === 1 ? '' : 's'} · registered {new Date(Number(maker.solana.registeredAt) * 1000).toLocaleDateString()}
          {maker.solana.paused ? ' · paused' : ''}
        </p>
      </header>

      <div className="grid gap-10 lg:grid-cols-2 lg:gap-12">
        <section className="grid content-start gap-4" aria-labelledby="id-h">
          <h2 id="id-h">Identity</h2>
          <dl className="kv">
            <dt>Maker account</dt>
            <dd>
              <Copyable value={pda} label="maker account" />
            </dd>
            <dt>Owner key (cold)</dt>
            <dd>
              <Copyable value={maker.solana.owner} label="owner key" />
            </dd>
            <dt>Operator key (hot)</dt>
            <dd>
              <Copyable value={maker.solana.operator} label="operator key" />
            </dd>
            <dt>Ethereum identity</dt>
            <dd>
              {link.status === 'mutual' && maker.ethereum ? (
                <>
                  <Copyable value={maker.ethereum.address} label="Ethereum address" /> <span className="pill pill-safe">linked both ways</span>
                </>
              ) : link.status === 'one-sided' ? (
                <span>A link is claimed on one chain only. It is ignored: nobody can attach themselves to another maker's record.</span>
              ) : maker.identity.historical ? (
                'The link to its Ethereum identity was removed. The history from while they were linked stays attached and is counted below: a maker cannot shed a record by unlinking.'
              ) : (
                'None'
              )}
              {link.pendingChange ? <span className="block text-sm text-warn-text">A change to this link is scheduled. Changes take 7 days to apply, and past history stays attached to both keys.</span> : null}
            </dd>
            <dt>Onion address</dt>
            <dd>{maker.onion ? <Copyable value={maker.onion} label="onion address" /> : 'None: messages go on-chain'}</dd>
            <dt>Inbox</dt>
            <dd>{maker.solana.inboxPolicy === 1 ? 'Only takers that have a swap with this maker' : 'Open to anyone'}</dd>
          </dl>
        </section>

        <section className="grid content-start gap-4" aria-labelledby="rep-h">
          <h2 id="rep-h">Record{maker.identity.merged ? ', Solana and Ethereum combined' : ''}</h2>
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="label">Approval rate</dt>
              <dd className="figure m-0">{formatPercent(rep.approvalRate)}</dd>
              <dd className="m-0 text-sm muted">{rep.meanResponseSecs !== null ? `answers in about ${formatDuration(Math.round(rep.meanResponseSecs))}` : 'no approvals yet'}</dd>
            </div>
            <div>
              <dt className="label">Withhold rate</dt>
              <dd className="figure m-0">{formatPercent(rep.withholdRate)}</dd>
              <dd className="m-0 text-sm muted">{rep.unreleased} never released ({formatPercent(rep.unreleasedRate)})</dd>
            </div>
          </dl>
          <div className="panel overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Counter</th>
                  <th scope="col" className="right">
                    Count
                  </th>
                  <th scope="col" className="right">
                    Per 100 completed
                  </th>
                </tr>
              </thead>
              <tbody>
                {SHOWN.map((name) => (
                  <tr key={name}>
                    <td>{COUNTER_TEXT[name]}</td>
                    <td className="right num">{rep.counts[name]}</td>
                    <td className="right num">{name === 'completed' || rep.completed === 0 ? '' : ((rep.counts[name] / rep.completed) * 100).toFixed(1)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-sm muted">Refunds cost no fee, so a maker trading with itself can inflate approvals and returned deposits cheaply. Completed swaps cost the 0.05% protocol fee, which is why every figure is also shown against them.</p>
        </section>
      </div>

      <section className="grid gap-3" aria-labelledby="contact-h">
        <h2 id="contact-h">Other contact channels</h2>
        {contacts.length === 0 ? (
          <p className="muted">This maker lists none. The inbox below always works.</p>
        ) : (
          <>
            <Notice kind="warn" title={CONTACT_WARNING}>
              Anyone who asks for either through these channels is trying to take your funds.
            </Notice>
            <dl className="kv">
              {contacts.map((c, i) => (
                <div key={i} className="contents">
                  <dt>{KIND[c.kind] ?? 'Other'}</dt>
                  <dd>
                    <code className="break-all">{c.value}</code> <span className="pill">maker-provided</span>
                  </dd>
                </div>
              ))}
            </dl>
          </>
        )}
      </section>

      <section className="grid gap-4" aria-labelledby="inbox-h">
        <div className="grid gap-1">
          <h2 id="inbox-h">Inbox</h2>
          <p className="muted prose-w">
            Messages are encrypted in this page to the maker's published key. {maker.onion ? 'They travel over Tor through the relay when it is reachable, otherwise on-chain.' : 'This maker lists no onion address, so they are posted on-chain: who messaged whom, and when, is public; the content is not.'} A
            reply is shown only if it is signed by the maker's operator key.
          </p>
        </div>
        {!vault.unlocked ? (
          <Notice kind="info" title="Load your recovery file to use the inbox">
            Replies are encrypted to keys derived from your recovery seed. <a href={href('settings')}>Open Settings</a>.
          </Notice>
        ) : (
          <>
            {thread && thread.items.length > 0 ? (
              <ol className="m-0 grid list-none gap-2 p-0" aria-label="Messages">
                {thread.items.map((m, i) => (
                  <li key={i} className={`panel max-w-[42rem] p-3 ${m.dir === 'out' ? 'justify-self-end bg-raised' : 'justify-self-start'}`}>
                    <p className="text-sm faint">
                      {m.dir === 'out' ? 'You' : 'Maker (signature verified)'} · {new Date(m.at).toLocaleString()} · {m.via === 'tor' ? 'over Tor' : 'on-chain'}
                      {m.action === 'release_deposit' ? ' · asks for a deposit release' : ''}
                    </p>
                    <p className="whitespace-pre-wrap break-words">{m.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="muted">No messages with this maker yet.</p>
            )}
            <form
              className="grid max-w-2xl gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                void send();
              }}
            >
              <Field label="Message" hint={`${text.length} of 2,000 characters`} error={error}>
                {(p) => <textarea {...p} className="textarea" rows={4} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} />}
              </Field>
              {swaps.length > 0 ? (
                <Field label="About swap (optional)">
                  {(p) => (
                    <select {...p} className="select" value={about} onChange={(e) => setAbout(e.target.value)}>
                      <option value="">No particular swap</option>
                      {swaps.map((t) => (
                        <option key={t.ref} value={t.ref}>
                          {t.ref.slice(0, 10)}…
                        </option>
                      ))}
                    </select>
                  )}
                </Field>
              ) : null}
              {about ? (
                <label className="check">
                  <input type="checkbox" checked={release} onChange={(e) => setRelease(e.target.checked)} />
                  <span>
                    <strong>Ask the maker to release my withheld deposit</strong>
                    <span className="block text-sm muted">Puts a "release" action next to this message in the maker's console. Only the maker can release it; after 60 days half is lost.</span>
                  </span>
                </label>
              ) : null}
              <div className="flex flex-wrap items-center gap-3">
                <button type="submit" className="btn btn-primary" disabled={busy || text.trim() === ''}>
                  {busy ? 'Sending…' : 'Send encrypted message'}
                </button>
                <button type="button" className="btn" onClick={() => void app.refreshThread(maker).then(setThread)}>
                  Check for replies
                </button>
                {sentVia ? (
                  <span className="text-sm muted" role="status">
                    Sent {sentVia === 'tor' ? 'over Tor' : 'on-chain'}.
                  </span>
                ) : null}
              </div>
            </form>
          </>
        )}
      </section>

      {rows.some((r) => r.mode !== 0) && vault.unlocked ? (
        <section className="grid gap-3" aria-labelledby="appr-h">
          <h2 id="appr-h">Advance approval</h2>
          <p className="muted prose-w">Ask this maker to approve your wallet address once. With an approval, locks against its window and approval-only offers start at once until the approval expires.</p>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="btn"
              disabled={!wallets.solana}
              onClick={() => {
                setApproval('Asking…');
                app.requestApproval(maker).then(
                  (r) => setApproval(r === 'granted' ? 'Approved. The approval is stored in this browser and used automatically.' : r === 'refused' ? 'The maker declined.' : 'Request posted on-chain. Check back for the answer.'),
                  (e: unknown) => setApproval(e instanceof Error ? e.message : String(e)),
                );
              }}
            >
              Request approval for my wallet
            </button>
            <button type="button" className="btn btn-quiet" disabled={!wallets.solana} onClick={() => void app.collectApproval(maker).then((ok) => setApproval(ok ? 'Approved. The approval is stored in this browser.' : 'No answer yet.'))}>
              Check for an answer
            </button>
            {!wallets.solana ? <span className="text-sm muted">Connect your Solana wallet first.</span> : null}
            {approval ? (
              <span className="text-sm" role="status">
                {approval}
              </span>
            ) : null}
          </div>
        </section>
      ) : null}
    </div>
  );
}
