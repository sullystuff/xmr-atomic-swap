/** Registration (both chains and the identity link), Keys and Status. */
import { useEffect, useId, useState } from 'react';
import { CHAIN_CONSTS, CONTACT_KIND, MAX_CONTACTS, MAX_CONTACT_LEN, base58Encode, fromHex, type ChainName } from '@xmrswap/protocol';
import type { ChainPause, LinkEntry } from '../api/extensions.js';
import type { EncKeyView, LinkStatus, RegistrationAction, RegistrationResponse, RegistrationTxResponse, TxResult } from '@xmrswap/protocol/daemon-api';
import { describeError } from '../api/client.js';
import { useAction, useClient, useLive, useNow, useQuery, useToasts } from '../api/hooks.js';
import { patchConfig } from '../lib/config/patch.js';
import { chainLabel } from '../lib/config/schema.js';
import { setPath } from '../lib/config/toml.js';
import { fmtDuration, fmtTime } from '../lib/format.js';
import { watchSigners, type OwnerSigner } from '../lib/wallet.js';
import { UpgradeTable, upgradeSummary } from '../ui/domain.js';
import { Async, Badge, Button, Card, ConfirmButton, Countdown, Empty, Id, Notice, PageHead, Stat, Time } from '../ui/kit.js';
import { AlertList } from './monitor.js';

// ------------------------------------------------------------------ registration

const CONTACT_LABEL: Record<number, string> = {
  [CONTACT_KIND.WEBSITE]: 'Website',
  [CONTACT_KIND.EMAIL]: 'Email',
  [CONTACT_KIND.MATRIX]: 'Matrix',
  [CONTACT_KIND.DISCORD]: 'Discord',
  [CONTACT_KIND.TELEGRAM]: 'Telegram',
  [CONTACT_KIND.BLOB_ENDPOINT]: 'Blob endpoint',
  [CONTACT_KIND.OTHER]: 'Other',
};
const LINK_DELAY_DAYS = CHAIN_CONSTS.solana.linkDelaySecs / 86_400;

/**
 * One owner-key action from start to finish: the daemon builds the unsigned transaction, the
 * owner signs it in a wallet or offline, the daemon relays it.
 */
function OwnerTransaction({ action, onDone, onCancel }: { action: RegistrationAction; onDone: (tx: TxResult) => void; onCancel: () => void }) {
  const client = useClient();
  const id = useId();
  const [built, setBuilt] = useState<RegistrationTxResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [signed, setSigned] = useState('');
  const [busy, setBusy] = useState<string | null>('build');
  const [signers, setSigners] = useState<OwnerSigner[]>([]);

  useEffect(() => watchSigners(setSigners), []);
  useEffect(() => {
    let live = true;
    setBusy('build');
    client.call('registrationTx', { body: action }).then(
      (r) => {
        if (!live) return;
        setBuilt(r);
        setBusy(null);
      },
      (e: unknown) => {
        if (!live) return;
        setError(describeError(e));
        setBusy(null);
      },
    );
    return () => {
      live = false;
    };
    // The action object is fixed for the life of this panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  const submit = async (value: string): Promise<void> => {
    if (!built) return;
    setBusy('submit');
    setError(null);
    try {
      onDone(await client.call('registrationSubmit', { body: { request_id: built.request_id, signed: value.trim() } }));
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(null);
    }
  };
  const signWith = async (s: OwnerSigner): Promise<void> => {
    if (!built) return;
    setBusy(`sign:${s.name}`);
    setError(null);
    try {
      const value = await s.sign(built.unsigned);
      setSigned(value);
      await submit(value);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(null);
    }
  };

  const usable = signers.filter((s) => s.chain === action.chain);
  return (
    <section className="notice" aria-label="Owner transaction" style={{ marginTop: 10 }}>
      {busy === 'build' ? <p role="status">The daemon is building the unsigned transaction…</p> : null}
      {built ? (
        <div className="stack" style={{ gap: 8 }}>
          <p>
            <strong>Signing this will:</strong> {built.summary}
          </p>
          <label htmlFor={`${id}-u`} className="muted">
            Unsigned transaction for the owner key on {chainLabel(action.chain)}
          </label>
          <textarea id={`${id}-u`} readOnly rows={4} value={JSON.stringify(built.unsigned, null, 1)} />
          <div className="row">
            {usable.map((s) => (
              <Button key={s.name} variant="primary" busy={busy === `sign:${s.name}`} onClick={() => void signWith(s)}>
                Sign with {s.name}
              </Button>
            ))}
            {usable.length === 0 ? <span className="muted">No {chainLabel(action.chain)} wallet was found in this browser. Sign offline with the owner key and paste the result.</span> : null}
          </div>
          <label htmlFor={`${id}-s`}>Signed transaction {action.chain === 'solana' ? '(base64)' : '(raw, 0x-hex)'}</label>
          <textarea id={`${id}-s`} rows={3} value={signed} spellCheck={false} onChange={(e) => setSigned(e.target.value)} />
          <div className="row">
            <Button variant={usable.length === 0 ? 'primary' : 'default'} disabled={signed.trim() === ''} busy={busy === 'submit'} onClick={() => void submit(signed)}>
              Relay the signed transaction
            </Button>
            <Button onClick={onCancel}>Cancel</Button>
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="msg error" role="alert" style={{ marginTop: 6 }}>
          <b>Error:</b> {error}{' '}
          {!built ? (
            <Button small onClick={onCancel}>
              Close
            </Button>
          ) : null}
        </p>
      ) : null}
    </section>
  );
}

/** A small form that collects the fields of one owner action, then hands over to `OwnerTransaction`. */
function ActionForm({
  label,
  fields,
  build,
  disabled,
  disabledReason,
  onDone,
}: {
  label: string;
  fields: { key: string; label: string; placeholder?: string }[];
  build: (values: Record<string, string>) => RegistrationAction;
  disabled?: boolean;
  disabledReason?: string;
  onDone: () => void;
}) {
  const id = useId();
  const [values, setValues] = useState<Record<string, string>>({});
  const [action, setAction] = useState<RegistrationAction | null>(null);
  const [result, setResult] = useState<TxResult | null>(null);
  const complete = fields.every((f) => (values[f.key] ?? '').trim() !== '');
  return (
    <div style={{ marginTop: 10 }}>
      <form
        className="row"
        style={{ alignItems: 'flex-end', gap: '6px 10px' }}
        onSubmit={(e) => {
          e.preventDefault();
          setResult(null);
          setAction(build(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.trim()]))));
        }}
      >
        {fields.map((f) => (
          <div className="field" key={f.key} style={{ flex: 1, minWidth: 180 }}>
            <label htmlFor={`${id}-${f.key}`}>{f.label}</label>
            <input
              id={`${id}-${f.key}`}
              type="text"
              className="w-wide"
              spellCheck={false}
              autoComplete="off"
              placeholder={f.placeholder}
              value={values[f.key] ?? ''}
              disabled={disabled || action !== null}
              onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
            />
          </div>
        ))}
        <button type="submit" className="btn" disabled={disabled || !complete || action !== null}>
          {label}
        </button>
      </form>
      {disabled && disabledReason ? <p className="help muted">{disabledReason}</p> : null}
      {action ? (
        <OwnerTransaction
          action={action}
          onCancel={() => setAction(null)}
          onDone={(tx) => {
            setAction(null);
            setValues({});
            setResult(tx);
            onDone();
          }}
        />
      ) : null}
      {result ? <TxNotice tx={result} /> : null}
    </div>
  );
}

function TxNotice({ tx }: { tx: TxResult }) {
  return (
    <div style={{ marginTop: 8 }}>
      <Notice tone={tx.status === 'failed' ? 'bad' : 'ok'} title={tx.status === 'failed' ? 'The transaction failed.' : tx.status === 'confirmed' ? 'Relayed and confirmed.' : 'Relayed.'}>
        {tx.error ?? ''} <Id value={tx.id} head={10} tail={8} />
      </Notice>
    </div>
  );
}

function linkState(reg: RegistrationResponse): { tone: 'ok' | 'warn' | 'plain'; label: string; text: string } {
  const s = reg.solana.link;
  const e = reg.ethereum.link;
  if (s.mutual && e.mutual) return { tone: 'ok', label: 'Linked both ways', text: 'Both records point at each other, each written by its own chain’s key. Takers see one profile with the history of both chains combined, and a fault on either chain counts against the whole identity.' };
  if (s.current || e.current) return { tone: 'warn', label: 'One-sided', text: 'Only one record points at the other, or they do not point at each other. A pointer in one direction is ignored: clients show two separate makers until both records agree.' };
  return { tone: 'plain', label: 'Not linked', text: 'Neither record names the other. Takers see a separate profile and history on each chain.' };
}

function LinkSide({ title, link, target }: { title: string; link: LinkStatus; target: string }) {
  return (
    <div>
      <h3 className="subhead">{title}</h3>
      <dl className="kv">
        <dt>Points at</dt>
        <dd>{link.current ? <code style={{ overflowWrap: 'anywhere' }}>{link.current}</code> : <span className="muted">nothing</span>}</dd>
        {link.pending !== null ? (
          <>
            <dt>Pending change</dt>
            <dd>
              <Badge tone="warn">Pending</Badge> {link.pending === '' ? 'remove the link' : <code style={{ overflowWrap: 'anywhere' }}>{link.pending}</code>}
            </dd>
            <dt>Takes effect in</dt>
            <dd>
              <strong>
                <Countdown to={link.pending_effective_at} soonBelow={86_400} urgentBelow={3_600} passed="now in effect" />
              </strong>{' '}
              <span className="muted">({fmtTime(link.pending_effective_at)})</span>
            </dd>
          </>
        ) : (
          <>
            <dt>Pending change</dt>
            <dd className="muted">none</dd>
          </>
        )}
      </dl>
      <p className="help muted" style={{ marginTop: 4 }}>
        Expected target: {target}
      </p>
    </div>
  );
}

export function RegistrationPage() {
  const reg = useQuery('registration', undefined, ['status']);
  const { status } = useLive();
  const [removing, setRemoving] = useState<RegistrationAction | null>(null);
  const [removed, setRemoved] = useState<TxResult | null>(null);
  const [historyKey, setHistoryKey] = useState(0);
  return (
    <>
      <PageHead title="Registration">
        Your record on each chain is what takers see when choosing a maker. The cold owner key controls the registration and the identity link; the hot operator key, held by the daemon, publishes offers and claims.
      </PageHead>
      <Async query={reg} what="the registration">
        {(r) => {
          const ls = linkState(r);
          const done = (): void => {
            reg.reload();
            setHistoryKey((k) => k + 1);
          };
          return (
            <div className="stack">
              <Notice tone="info" title="The owner key never touches this console or the daemon.">
                For each owner action the daemon builds an unsigned transaction, you sign it with the owner’s wallet (or offline), and the daemon relays it.
              </Notice>
              <div className="cols-2">
                <Card title="Solana registration" actions={r.solana.registered ? <Badge tone="ok">Registered</Badge> : <Badge tone="warn">Not registered</Badge>}>
                  {r.solana.registered ? (
                    <>
                      <dl className="kv">
                        <dt>Maker account</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.solana.maker}</code>
                        </dd>
                        <dt>Owner (cold)</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.solana.owner}</code>
                        </dd>
                        <dt>Operator (hot)</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.solana.operator}</code>
                        </dd>
                        <dt>Payout</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.solana.payout}</code>
                          <div>{r.solana.payout_usdc_account === true ? <span className="muted">its USDC token account exists</span> : r.solana.payout_usdc_account === false ? <Badge tone="bad">Its USDC token account is missing: USDC payouts would be parked</Badge> : null}</div>
                        </dd>
                        <dt>Encryption key</dt>
                        <dd>
                          version {r.solana.enc_key_version ?? 'n/a'} · <a href="#/keys">rotation</a>
                        </dd>
                      </dl>
                      <ActionForm label="Change operator" fields={[{ key: 'operator', label: 'New operator key' }]} build={(v) => ({ chain: 'solana', action: 'set_operator', operator: v.operator ?? '' })} onDone={done} />
                      <ActionForm label="Change payout" fields={[{ key: 'payout', label: 'New payout address' }]} build={(v) => ({ chain: 'solana', action: 'set_payout', payout: v.payout ?? '' })} onDone={done} />
                    </>
                  ) : (
                    <>
                      <p>Every maker registers on Solana, including Ethereum-only makers: offers and signed Ethereum quotes are published there.</p>
                      <ActionForm
                        label="Register on Solana"
                        fields={[
                          { key: 'owner', label: 'Owner key (cold)' },
                          { key: 'operator', label: 'Operator key (hot)' },
                          { key: 'payout', label: 'Payout address' },
                        ]}
                        build={(v) => ({ chain: 'solana', action: 'register_maker', owner: v.owner ?? '', operator: v.operator ?? '', payout: v.payout ?? '' })}
                        onDone={done}
                      />
                    </>
                  )}
                </Card>

                <Card title="Ethereum registration" actions={r.ethereum.registered ? <Badge tone="ok">Registered</Badge> : <Badge tone="warn">Not registered</Badge>}>
                  {r.ethereum.registered ? (
                    <>
                      <dl className="kv">
                        <dt>Maker (owner)</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.ethereum.maker}</code>
                        </dd>
                        <dt>Operator (hot)</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.ethereum.operator}</code>
                        </dd>
                        <dt>Payout</dt>
                        <dd>
                          <code style={{ overflowWrap: 'anywhere' }}>{r.ethereum.payout}</code>
                        </dd>
                        <dt>Epochs</dt>
                        <dd>
                          quote {r.ethereum.quote_epoch ?? 'n/a'} · approval {r.ethereum.approval_epoch ?? 'n/a'}
                        </dd>
                      </dl>
                      <ActionForm label="Change operator" fields={[{ key: 'operator', label: 'New operator address' }]} build={(v) => ({ chain: 'ethereum', action: 'set_operator', operator: v.operator ?? '' })} onDone={done} />
                      <ActionForm label="Change payout" fields={[{ key: 'payout', label: 'New payout address' }]} build={(v) => ({ chain: 'ethereum', action: 'set_payout', payout: v.payout ?? '' })} onDone={done} />
                    </>
                  ) : (
                    <>
                      <p>The Ethereum record points to the Solana one for the encryption key, its rotation and the onion address, which avoids paying Ethereum gas for every rotation.</p>
                      <ActionForm
                        label="Register on Ethereum"
                        disabled={!r.solana.registered}
                        disabledReason="Register on Solana first: every maker registers there, including Ethereum-only makers."
                        fields={[
                          { key: 'owner', label: 'Owner address (cold)' },
                          { key: 'operator', label: 'Operator address (hot)' },
                          { key: 'payout', label: 'Payout address' },
                        ]}
                        build={(v) => ({ chain: 'ethereum', action: 'register_maker', owner: v.owner ?? '', operator: v.operator ?? '', payout: v.payout ?? '', solana_owner: r.solana.owner ?? '' })}
                        onDone={done}
                      />
                    </>
                  )}
                </Card>
              </div>

              <Card title="Identity link" actions={<Badge tone={ls.tone}>{ls.label}</Badge>}>
                <p data-testid="link-state">{ls.text}</p>
                <div className="cols-2" style={{ marginTop: 10 }}>
                  <LinkSide title="Solana record → Ethereum address" link={r.solana.link} target={r.ethereum.maker ?? 'your Ethereum maker address, once registered'} />
                  <LinkSide title="Ethereum record → Solana key" link={r.ethereum.link} target={r.solana.owner ?? 'your Solana owner key, once registered'} />
                </div>
                <div style={{ marginTop: 10 }}>
                  <Notice tone="warn" title="Changing or removing a link leaves a trace.">
                    The first link takes effect at once. Any later change or removal is a recorded on-chain event and takes effect only after {LINK_DELAY_DAYS} days. Clients keep past history attached to both keys, so unlinking does not shed a bad record. Each key links to at most one counterpart.
                  </Notice>
                </div>
                <div className="cols-2">
                  <div>
                    <ActionForm
                      label={r.solana.link.current ? 'Change the Solana pointer' : 'Set the Solana pointer'}
                      disabled={!r.solana.registered}
                      disabledReason="Register on Solana first."
                      fields={[{ key: 'eth', label: 'Ethereum address to point at', ...(r.ethereum.maker ? { placeholder: r.ethereum.maker } : {}) }]}
                      build={(v) => ({ chain: 'solana', action: 'set_eth_link', eth_address: v.eth ?? '' })}
                      onDone={done}
                    />
                    {r.solana.link.current ? (
                      <div style={{ marginTop: 8 }}>
                        <ConfirmButton label="Remove the Solana pointer" variant="danger" small onConfirm={() => setRemoving({ chain: 'solana', action: 'set_eth_link', eth_address: '' })}>
                          Remove the link from the Solana record. The removal is recorded on chain, takes effect after {LINK_DELAY_DAYS} days, and past history stays attached to both keys.
                        </ConfirmButton>
                      </div>
                    ) : null}
                  </div>
                  <div>
                    <ActionForm
                      label={r.ethereum.link.current ? 'Change the Ethereum pointer' : 'Set the Ethereum pointer'}
                      disabled={!r.ethereum.registered}
                      disabledReason="Register on Ethereum first."
                      fields={[{ key: 'sol', label: 'Solana owner key to point at', ...(r.solana.owner ? { placeholder: r.solana.owner } : {}) }]}
                      build={(v) => ({ chain: 'ethereum', action: 'set_solana_link', solana_owner: v.sol ?? '' })}
                      onDone={done}
                    />
                    {r.ethereum.link.current ? (
                      <div style={{ marginTop: 8 }}>
                        <ConfirmButton label="Remove the Ethereum pointer" variant="danger" small onConfirm={() => setRemoving({ chain: 'ethereum', action: 'set_solana_link', solana_owner: '' })}>
                          Remove the link from the Ethereum record. The removal is recorded on chain, takes effect after {LINK_DELAY_DAYS} days, and past history stays attached to both keys.
                        </ConfirmButton>
                      </div>
                    ) : null}
                  </div>
                </div>
                <LinkHistory reloadKey={historyKey} />
                {removing ? (
                  <OwnerTransaction
                    key={removing.chain}
                    action={removing}
                    onCancel={() => setRemoving(null)}
                    onDone={(tx) => {
                      setRemoving(null);
                      setRemoved(tx);
                      done();
                    }}
                  />
                ) : null}
                {removed ? <TxNotice tx={removed} /> : null}
              </Card>

              <OwnerPause ownerPaused={status?.paused.owner ?? null} perChain={status?.paused.chains} registered={{ solana: r.solana.registered, ethereum: r.ethereum.registered }} onDone={done} />

              <Card title="Contact channels" note="Published in the Solana record by the daemon’s operator key.">
                <dl className="kv">
                  <dt>Onion address</dt>
                  <dd>
                    {r.solana.onion ? <code style={{ overflowWrap: 'anywhere' }}>{r.solana.onion}</code> : <span className="muted">none listed: takers reach you over on-chain messaging</span>}
                    {status?.tor.enabled ? <span className="muted"> · Tor service {status.tor.reachable ? 'reachable' : 'not reachable'}</span> : null}
                  </dd>
                  <dt>Inbox</dt>
                  <dd>{r.solana.inbox_policy === 'swap_only' ? 'Only takers who have a swap with you may write' : r.solana.inbox_policy === 'open' ? 'Open to anyone (each message costs the sender a transaction fee)' : 'n/a'}</dd>
                  <dt>Blob endpoint</dt>
                  <dd>
                    {r.blob_endpoint ? <Badge tone="ok">Listed</Badge> : <Badge tone="warn">Not listed</Badge>}{' '}
                    <span className="muted">{r.blob_endpoint ? 'Ethereum markets can run.' : 'Ethereum markets cannot be enabled without one: the taker’s proof is too large for any chain.'}</span>
                  </dd>
                  <dt>Other channels</dt>
                  <dd>
                    {r.solana.contacts.length === 0 ? (
                      <span className="muted">none</span>
                    ) : (
                      <ul style={{ margin: 0, paddingLeft: 16 }}>
                        {r.solana.contacts.map((c) => (
                          <li key={`${c.kind}-${c.value}`}>
                            {CONTACT_LABEL[c.kind] ?? `Kind ${c.kind}`}: <code style={{ overflowWrap: 'anywhere' }}>{c.value}</code>
                          </li>
                        ))}
                      </ul>
                    )}
                  </dd>
                </dl>
                <p className="muted" style={{ marginTop: 8 }}>
                  Takers see these labelled as provided by you and not verified.
                </p>
                <PublishedEditor reg={r} torEnabled={status?.tor.enabled ?? false} onDone={done} />
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}

/** A link target as the chain stores it (0x-hex bytes), shown the way the maker knows it. */
export function linkTarget(hex: string): string | null {
  const body = hex.replace(/^0x/, '');
  if (body === '' || /^0+$/.test(body)) return null;
  if (body.length === 40) return `0x${body}`;
  if (body.length === 64) {
    try {
      return base58Encode(fromHex(body));
    } catch {
      return `0x${body}`;
    }
  }
  return `0x${body}`;
}

/** The identity link's trace: every recorded change on both chains. */
function LinkHistory({ reloadKey }: { reloadKey: number }) {
  const client = useClient();
  const now = useNow();
  const [state, setState] = useState<{ entries?: LinkEntry[]; error?: unknown }>({});
  const [nonce, setNonce] = useState(0);
  useEffect(() => {
    let live = true;
    client.linkHistory().then(
      (r) => live && setState({ entries: r.entries }),
      (error: unknown) => live && setState({ error }),
    );
    return () => {
      live = false;
    };
  }, [client, reloadKey, nonce]);
  return (
    <div style={{ marginTop: 12 }}>
      <h3 className="subhead">Link history</h3>
      {state.error ? (
        <Notice tone="bad" title="Could not load the link history.">
          {describeError(state.error)}{' '}
          <Button small onClick={() => setNonce((n) => n + 1)}>
            Try again
          </Button>
        </Notice>
      ) : state.entries === undefined ? (
        <p className="muted" role="status">
          Reading the recorded link changes…
        </p>
      ) : state.entries.length === 0 ? (
        <p className="muted">No link change has been recorded on either chain.</p>
      ) : (
        <div className="table-wrap">
          <table className="tbl" aria-label="Link history">
            <thead>
              <tr>
                <th scope="col">Record</th>
                <th scope="col">From</th>
                <th scope="col">To</th>
                <th scope="col">In effect</th>
              </tr>
            </thead>
            <tbody>
              {state.entries.map((e, i) => {
                const from = linkTarget(e.old);
                const to = linkTarget(e.new);
                return (
                  <tr key={`${e.chain}-${e.effective_at}-${i}`}>
                    <th scope="row">{chainLabel(e.chain)}</th>
                    <td>{from ? <code style={{ overflowWrap: 'anywhere' }}>{from}</code> : <span className="muted">no link</span>}</td>
                    <td>{to ? <code style={{ overflowWrap: 'anywhere' }}>{to}</code> : <span className="muted">link removed</span>}</td>
                    <td>
                      {e.effective_at > now ? <Badge tone="warn">Pending</Badge> : null} <span className="mono">{fmtTime(e.effective_at)}</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="muted" style={{ marginTop: 4 }}>
        Read from the chains’ own records. This trace is public and cannot be removed.
      </p>
    </div>
  );
}

const CONTACT_KINDS: { value: number; label: string }[] = [
  { value: CONTACT_KIND.WEBSITE, label: 'Website' },
  { value: CONTACT_KIND.EMAIL, label: 'Email' },
  { value: CONTACT_KIND.MATRIX, label: 'Matrix' },
  { value: CONTACT_KIND.DISCORD, label: 'Discord' },
  { value: CONTACT_KIND.TELEGRAM, label: 'Telegram' },
  { value: CONTACT_KIND.BLOB_ENDPOINT, label: 'Blob endpoint' },
  { value: CONTACT_KIND.OTHER, label: 'Other' },
];
const ONION = /^[a-z2-7]{56}\.onion$/;
const bytes = (v: string): number => new TextEncoder().encode(v).length;

/** Edit what the operator key publishes: contact channels and the onion address. */
function PublishedEditor({ reg, torEnabled, onDone }: { reg: RegistrationResponse; torEnabled: boolean; onDone: () => void }) {
  const client = useClient();
  const { notify } = useToasts();
  const id = useId();
  const [contacts, setContacts] = useState(() => reg.solana.contacts.map((c) => ({ ...c })));
  const [onion, setOnion] = useState(reg.solana.onion ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ tx: TxResult | null } | null>(null);
  const savedContacts = JSON.stringify(reg.solana.contacts);
  const dirty = JSON.stringify(contacts) !== savedContacts || onion.trim() !== (reg.solana.onion ?? '');
  const problems: string[] = [];
  contacts.forEach((c, i) => {
    if (c.value.trim() === '') problems.push(`Channel ${i + 1} is empty.`);
    else if (bytes(c.value) > MAX_CONTACT_LEN) problems.push(`Channel ${i + 1} is ${bytes(c.value)} bytes; the registry holds at most ${MAX_CONTACT_LEN}.`);
  });
  const o = onion.trim();
  if (o !== '' && !ONION.test(o)) problems.push('The onion address must be a v3 address: 56 characters, then .onion.');
  const losesBlob = reg.blob_endpoint && o === '' && !contacts.some((c) => c.kind === CONTACT_KIND.BLOB_ENDPOINT);

  const save = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await client.publishRegistration({
        ...(JSON.stringify(contacts) !== savedContacts ? { contacts: contacts.map((c) => ({ kind: c.kind, value: c.value.trim() })) } : {}),
        ...(o !== (reg.solana.onion ?? '') ? { onion: o === '' ? null : o } : {}),
      });
      setResult({ tx: res.tx });
      notify('ok', res.tx ? 'Published with the operator key.' : 'Nothing to publish: the registry already shows this.');
      onDone();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="stack"
      aria-label="Edit contact channels"
      style={{ marginTop: 12 }}
      onSubmit={(e) => {
        e.preventDefault();
        if (problems.length === 0) void save();
      }}
    >
      <h3 className="subhead">Edit what is published</h3>
      <div className="field">
        <label htmlFor={`${id}-onion`}>Onion address</label>
        <input id={`${id}-onion`} type="text" className="w-wide" spellCheck={false} autoComplete="off" value={onion} placeholder="none" aria-describedby={`${id}-onion-h`} onChange={(e) => setOnion(e.target.value)} />
        <p className="help" id={`${id}-onion-h`}>
          Leave empty to follow the Tor service’s own hostname file{torEnabled ? '' : ' (the Tor service is off, so no address is published)'}. Takers prefer Tor when an address is listed and fall back to on-chain messaging.
        </p>
      </div>
      <div role="group" aria-label="Contact channels">
        {contacts.length === 0 ? <p className="muted">No other channels.</p> : null}
        <ul className="chips">
          {contacts.map((c, i) => (
            <li key={i}>
              <select aria-label={`Channel ${i + 1} kind`} value={c.kind} onChange={(e) => setContacts((list) => list.map((x, k) => (k === i ? { ...x, kind: Number(e.target.value) } : x)))}>
                {CONTACT_KINDS.some((k) => k.value === c.kind) ? null : <option value={c.kind}>Kind {c.kind}</option>}
                {CONTACT_KINDS.map((k) => (
                  <option key={k.value} value={k.value}>
                    {k.label}
                  </option>
                ))}
              </select>
              <input type="text" aria-label={`Channel ${i + 1} value`} style={{ flex: 1, minWidth: 180 }} spellCheck={false} value={c.value} aria-invalid={c.value.trim() === '' || bytes(c.value) > MAX_CONTACT_LEN ? true : undefined} onChange={(e) => setContacts((list) => list.map((x, k) => (k === i ? { ...x, value: e.target.value } : x)))} />
              <Button small variant="ghost" aria-label={`Remove channel ${i + 1}`} onClick={() => setContacts((list) => list.filter((_, k) => k !== i))}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
        <div style={{ marginTop: 4 }}>
          <Button small disabled={contacts.length >= MAX_CONTACTS} onClick={() => setContacts((list) => [...list, { kind: CONTACT_KIND.WEBSITE, value: '' }])}>
            Add a channel
          </Button>
          <span className="muted"> at most {MAX_CONTACTS}, each up to {MAX_CONTACT_LEN} bytes</span>
        </div>
      </div>
      {problems.map((p) => (
        <p key={p} className="msg error" role="alert">
          <b>Error:</b> {p}
        </p>
      ))}
      {losesBlob ? (
        <p className="msg warning">
          <b>Warning:</b> this leaves no blob endpoint (an onion address or a blob-endpoint channel). Ethereum markets need one and will be kept off.
        </p>
      ) : null}
      {error ? (
        <Notice tone="bad" title="Not published.">
          {error}
        </Notice>
      ) : null}
      {result ? (
        <Notice tone="ok" title={result.tx ? 'Sent to the registry.' : 'Already up to date.'}>
          {result.tx ? (
            <>
              One transaction signed by the operator key: <Id value={result.tx.id} head={10} tail={8} />
            </>
          ) : (
            'The registry already shows these channels.'
          )}
        </Notice>
      ) : null}
      <div className="row">
        <button type="submit" className="btn primary" disabled={!dirty || problems.length > 0 || busy}>
          Publish with the operator key
        </button>
        <Button
          disabled={!dirty || busy}
          onClick={() => {
            setContacts(reg.solana.contacts.map((c) => ({ ...c })));
            setOnion(reg.solana.onion ?? '');
          }}
        >
          Discard
        </Button>
      </div>
    </form>
  );
}

function OwnerPause({ ownerPaused, perChain, registered, onDone }: { ownerPaused: boolean | null; perChain: ChainPause[] | undefined; registered: Record<ChainName, boolean>; onDone: () => void }) {
  const [action, setAction] = useState<RegistrationAction | null>(null);
  const [result, setResult] = useState<TxResult | null>(null);
  const chains: ChainName[] = ['solana', 'ethereum'];
  return (
    <Card title="Owner pause" note="A pause set with the owner key. It holds even if the operator key is lost or stolen; the daemon’s own pause switch is in the top bar." actions={ownerPaused === null ? undefined : ownerPaused ? <Badge tone="warn">Paused by the owner key</Badge> : <Badge>Not paused by the owner key</Badge>}>
      {perChain ? (
        <dl className="kv" style={{ marginBottom: 10 }} data-testid="owner-pause-chains">
          {perChain.map((p) => (
            <div key={p.chain} style={{ display: 'contents' }}>
              <dt>{chainLabel(p.chain)}</dt>
              <dd>
                {p.owner ? <Badge tone="warn">Paused by the owner key</Badge> : <Badge>Owner key: not paused</Badge>} {p.operator ? <Badge tone="warn">Paused by the operator key</Badge> : null}
              </dd>
            </div>
          ))}
        </dl>
      ) : null}
      <div className="row">
        {chains.map((chain) => (
          <span key={chain} className="row">
            <ConfirmButton label={`Pause on ${chainLabel(chain)}`} small variant="danger" disabled={!registered[chain] || action !== null} onConfirm={() => setAction({ chain, action: 'set_paused', paused: true })}>
              Stop this maker’s offers on {chainLabel(chain)} with the owner key. Swaps already open keep running to their end.
            </ConfirmButton>
            <Button small disabled={!registered[chain] || action !== null} onClick={() => setAction({ chain, action: 'set_paused', paused: false })}>
              Resume on {chainLabel(chain)}
            </Button>
          </span>
        ))}
      </div>
      {action ? (
        <OwnerTransaction
          key={`${action.chain}-${String('paused' in action && action.paused)}`}
          action={action}
          onCancel={() => setAction(null)}
          onDone={(tx) => {
            setAction(null);
            setResult(tx);
            onDone();
          }}
        />
      ) : null}
      {result ? <TxNotice tx={result} /> : null}
    </Card>
  );
}

// ------------------------------------------------------------------ keys

export function keyState(k: EncKeyView, now: number): { label: string; tone: 'ok' | 'warn' | 'info' | 'plain'; note: string } {
  if (k.current) return { label: 'Current', tone: 'ok', note: 'New messages are encrypted to this key.' };
  if (k.deleted_at !== null) return { label: 'Deleted', tone: 'plain', note: `Private key deleted ${fmtTime(k.deleted_at)}.` };
  const expired = k.expires_at !== null && k.expires_at <= now;
  if (!expired) return { label: 'Retired, in grace', tone: 'info', note: `Kept for another ${k.expires_at === null ? 'while' : fmtDuration(k.expires_at - now)} so messages sent around the rotation still open${k.open_swaps > 0 ? `; ${k.open_swaps} open ${k.open_swaps === 1 ? 'swap still needs' : 'swaps still need'} it` : ''}.` };
  if (k.open_swaps > 0) return { label: 'Retired, kept for open swaps', tone: 'warn', note: `Its grace period has passed, but ${k.open_swaps} ${k.open_swaps === 1 ? 'swap opened under it is' : 'swaps opened under it are'} still open. It is deleted when the last one closes.` };
  return { label: 'Retired, due for deletion', tone: 'plain', note: 'Its grace period has passed and no swap needs it; the daemon deletes it shortly.' };
}

export function KeysPage() {
  const client = useClient();
  const keys = useQuery('keys', undefined, ['status']);
  const { busy, run } = useAction();
  const now = useNow();
  const id = useId();
  const [interval, setIntervalHours] = useState<string | null>(null);
  const [grace, setGrace] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <PageHead title="Keys">
        Takers encrypt messages to your published encryption key. Rotating it limits what a leaked key exposes. In-flight swaps are unaffected: each keeps its own session key through any number of rotations, and offers are published with the operator key, not this one.
      </PageHead>
      <Async query={keys} what="the keys">
        {(r) => {
          const iv = interval ?? String(r.rotation_interval_hours);
          const gr = grace ?? String(r.grace_hours);
          const dirty = Number(iv) !== r.rotation_interval_hours || Number(gr) !== r.grace_hours;
          const saveSchedule = async (): Promise<void> => {
            setError(null);
            const i = Number(iv);
            const g = Number(gr);
            if (!(iv.trim() !== '' && i >= 0) || !(gr.trim() !== '' && g >= 0)) return setError('Enter hours as numbers of 0 or more. An interval of 0 means rotation only on demand.');
            const res = await run('schedule', () => patchConfig(client, (cfg) => setPath(setPath(cfg, 'rotation.interval_hours', i), 'rotation.grace_hours', g)), 'Schedule saved and applied without a restart.');
            if (res) {
              setIntervalHours(null);
              setGrace(null);
              keys.reload();
            }
          };
          return (
            <div className="stack">
              <dl className="stats">
                <Stat label="Current version" value={r.keys.find((k) => k.current)?.version ?? 'n/a'} />
                <Stat label="Schedule" value={r.rotation_interval_hours === 0 ? 'On demand only' : `Every ${r.rotation_interval_hours} hours`} />
                <Stat label="Next rotation" value={r.next_rotation_at === null ? 'not scheduled' : <Countdown to={r.next_rotation_at} soonBelow={3_600} urgentBelow={0} passed="due now" />} hint={r.next_rotation_at === null ? undefined : fmtTime(r.next_rotation_at)} />
                <Stat label="Grace period" value={`${r.grace_hours} hours`} hint="a retired key is kept at least this long" />
              </dl>

              <div className="cols-2">
                <Card title="Rotation schedule">
                  <form
                    className="row"
                    style={{ alignItems: 'flex-end', gap: '8px 12px' }}
                    onSubmit={(e) => {
                      e.preventDefault();
                      void saveSchedule();
                    }}
                  >
                    <div className="field">
                      <label htmlFor={`${id}-i`}>Rotate every (hours)</label>
                      <input id={`${id}-i`} type="text" inputMode="decimal" className="w-num" value={iv} onChange={(e) => setIntervalHours(e.target.value)} aria-describedby={`${id}-ih`} />
                    </div>
                    <div className="field">
                      <label htmlFor={`${id}-g`}>Keep a retired key for (hours)</label>
                      <input id={`${id}-g`} type="text" inputMode="decimal" className="w-num" value={gr} onChange={(e) => setGrace(e.target.value)} />
                    </div>
                    <button type="submit" className="btn primary" disabled={!dirty || busy === 'schedule'}>
                      Save schedule
                    </button>
                  </form>
                  <p className="help muted" id={`${id}-ih`} style={{ marginTop: 6 }}>
                    0 = only on demand. The program enforces no minimum interval; each rotation costs one transaction fee. Saved to <code>[rotation]</code> in the configuration.
                  </p>
                  {error ? (
                    <p className="msg error" role="alert">
                      <b>Error:</b> {error}
                    </p>
                  ) : null}
                </Card>
                <Card title="Rotate on demand">
                  <p>Generates a fresh key, publishes it with one transaction signed by the operator key, and retires the current one into its grace period.</p>
                  <div style={{ marginTop: 10 }}>
                    <ConfirmButton
                      label="Rotate now"
                      variant="primary"
                      busy={busy === 'rotate'}
                      onConfirm={() => void run('rotate', () => client.call('keysRotate'), (x) => `Rotated to version ${x.version}. The previous key stays usable through its grace period.`).then(keys.reload)}
                    >
                      Publish a new encryption key now. Requests encrypted to a version that has expired are rejected and the taker’s client retries with the new key; nothing in flight is interrupted.
                    </ConfirmButton>
                  </div>
                </Card>
              </div>

              <Card title="Key versions" note="A retired private key is kept until its expiry has passed and every swap opened under it has closed, then deleted." flush>
                {r.keys.length === 0 ? (
                  <Empty title="No keys yet" />
                ) : (
                  <div className="table-wrap">
                    <table className="tbl" aria-label="Encryption key versions">
                      <thead>
                        <tr>
                          <th scope="col">Version</th>
                          <th scope="col">Public key</th>
                          <th scope="col">State</th>
                          <th scope="col">Expires</th>
                          <th scope="col" className="num">
                            Open swaps
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        {r.keys.map((k) => {
                          const st = keyState(k, now);
                          return (
                            <tr key={k.version}>
                              <th scope="row">{k.version}</th>
                              <td>
                                <Id value={k.public_key} head={10} tail={8} />
                              </td>
                              <td>
                                <Badge tone={st.tone}>{st.label}</Badge>
                                <div className="muted">{st.note}</div>
                              </td>
                              <td>{k.expires_at === null ? <span className="muted">n/a</span> : k.expires_at > now ? <Countdown to={k.expires_at} soonBelow={3_600} urgentBelow={0} /> : <span className="muted">{fmtTime(k.expires_at)}</span>}</td>
                              <td className="num">{k.open_swaps}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}

// ------------------------------------------------------------------ status

export function StatusPage() {
  const { status, statusError, refresh, connection } = useLive();
  if (!status) {
    return (
      <>
        <PageHead title="Status" />
        <div className="card">
          {statusError ? (
            <div className="card-body">
              <Notice tone="bad" title="Could not load the status.">
                {describeError(statusError)}{' '}
                <Button small onClick={refresh}>
                  Try again
                </Button>
              </Notice>
            </div>
          ) : (
            <Empty title="Waiting for the daemon" />
          )}
        </div>
      </>
    );
  }
  const up = upgradeSummary(status.chains);
  const paused = status.paused.owner || status.paused.operator || status.paused.guardrails.length > 0;
  return (
    <>
      <PageHead title="Status">Connections, node agreement and the state of the contracts this daemon acts on.</PageHead>
      <div className="stack">
        <dl className="stats">
          <Stat label="Mode" value={status.mode === 'live' ? 'Live' : 'Dry run'} hint={status.mode === 'live' ? 'transactions are sent' : 'nothing is sent, no XMR moves'} />
          <Stat label="Quoting" value={paused ? 'Paused' : 'Running'} tone={paused ? 'warn' : undefined} hint={paused ? [status.paused.owner ? 'by the owner key' : '', status.paused.operator ? 'by the pause switch' : '', ...status.paused.guardrails].filter(Boolean).join(', ') : 'no pause in effect'} />
          <Stat label="Daemon" value={status.version} hint={`core ${status.core_version}`} />
          <Stat label="Uptime" value={fmtDuration(status.uptime_secs)} hint={`started ${fmtTime(status.started_at)}`} />
          <Stat label="Console link" value={connection === 'live' ? 'Live' : connection === 'connecting' ? 'Connecting' : 'Polling'} hint={connection === 'live' ? 'push channel open' : 'push channel down; re-reading every 15 s'} tone={connection === 'offline' ? 'warn' : undefined} />
        </dl>

        <Card title="Contract upgrade status" flush>
          <div className="card-body">
            <Notice tone={up.tone} title={up.short + '.'} alert={false}>
              <span data-testid="upgrade-statement">{up.text}</span>
            </Notice>
          </div>
          <UpgradeTable chains={status.chains} />
        </Card>

        <Card title="Chain connections" flush>
          <div className="table-wrap">
            <table className="tbl" aria-label="Chain connections">
              <thead>
                <tr>
                  <th scope="col">Chain</th>
                  <th scope="col">Connection</th>
                  <th scope="col">Endpoint</th>
                  <th scope="col">Network</th>
                  <th scope="col">Chain time</th>
                  <th scope="col">Acting on</th>
                </tr>
              </thead>
              <tbody>
                {status.chains.map((c) => (
                  <tr key={c.chain}>
                    <th scope="row">{chainLabel(c.chain)}</th>
                    <td>
                      {c.connected ? <Badge tone="ok">Connected</Badge> : <Badge tone="bad">Disconnected</Badge>}
                      {c.last_error ? <div className="muted">{c.last_error}</div> : null}
                    </td>
                    <td>{c.endpoint}</td>
                    <td>
                      <Id value={c.network} /> {c.network_ok ? <span className="muted">matches the configuration</span> : <Badge tone="bad">Wrong network</Badge>}
                    </td>
                    <td>
                      {c.chain_time === null ? <span className="muted">n/a</span> : <span className="mono">{fmtTime(c.chain_time)}</span>}
                      {c.clock_skew_secs !== null ? <div className={Math.abs(c.clock_skew_secs) > 30 ? 'msg warning' : 'muted'}>local clock {c.clock_skew_secs >= 0 ? 'ahead' : 'behind'} by {Math.abs(c.clock_skew_secs)} s</div> : null}
                    </td>
                    <td>{c.finality ? `${c.finality} blocks` : <span className="muted">confirmed state</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <div className="cols-2">
          <Card title="Monero" actions={status.monero.agree ? <Badge tone="ok">Nodes agree</Badge> : <Badge tone="bad">Nodes disagree</Badge>} flush>
            <table className="tbl" aria-label="Monero nodes">
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col">State</th>
                  <th scope="col" className="num">
                    Height
                  </th>
                  <th scope="col">Top block</th>
                </tr>
              </thead>
              <tbody>
                {status.monero.nodes.map((n) => (
                  <tr key={n.label}>
                    <th scope="row">{n.label}</th>
                    <td>{n.ok ? <Badge tone="ok">Up</Badge> : <Badge tone="bad">Down</Badge>}</td>
                    <td className="num">{n.height ?? 'n/a'}</td>
                    <td>
                      <Id value={n.top_hash} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="card-body">
              <dl className="kv">
                <dt>Inventory wallet</dt>
                <dd>{status.monero.wallet_rpc_ok ? 'wallet-rpc reachable' : <Badge tone="bad">wallet-rpc unreachable</Badge>}</dd>
                <dt>Reorg guard</dt>
                <dd>{status.monero.reorg_guard_active ? <Badge tone="warn">Active: depth raised</Badge> : 'not triggered'}</dd>
              </dl>
            </div>
          </Card>
          <Card title="Tor and identity">
            <dl className="kv">
              <dt>Tor service</dt>
              <dd>{status.tor.enabled ? (status.tor.reachable ? <Badge tone="ok">Reachable</Badge> : <Badge tone="bad">Not reachable</Badge>) : <span className="muted">off: on-chain messaging only</span>}</dd>
              <dt>Onion address</dt>
              <dd>
                {status.tor.onion ? <code style={{ overflowWrap: 'anywhere' }}>{status.tor.onion}</code> : <span className="muted">none</span>} {status.tor.onion ? (status.tor.published ? <span className="muted">published</span> : <Badge tone="warn">Not published</Badge>) : null}
              </dd>
              <dt>Solana maker</dt>
              <dd>
                <Id value={status.maker.solana} head={10} tail={8} />
              </dd>
              <dt>Ethereum maker</dt>
              <dd>
                <Id value={status.maker.ethereum} head={10} tail={8} />
              </dd>
              <dt>Parked for review</dt>
              <dd>{status.needs_review === 0 ? 'nothing' : <a href="#/swaps">{status.needs_review} item(s)</a>}</dd>
            </dl>
          </Card>
        </div>

        <Card title="Alerts" flush>
          <AlertList alerts={status.alerts} />
        </Card>
      </div>
    </>
  );
}
