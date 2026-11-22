/**
 * Owner-key transactions: the daemon builds an unsigned transaction, the owner signs it in a
 * wallet or offline, the daemon relays it. Used for registration actions and parked payouts.
 */
import { useEffect, useId, useState } from 'react';
import type { ChainName } from '@xmrswap/protocol';
import type { RegistrationTxResponse, TxResult } from '@xmrswap/protocol/daemon-api';
import { describeError } from '../api/client.js';
import { useClient } from '../api/hooks.js';
import { chainLabel } from '../lib/config/schema.js';
import { watchSigners, type OwnerSigner } from '../lib/wallet.js';
import { Button, Id, Notice } from './kit.js';

/**
 * One owner-key action from start to finish: the daemon builds the unsigned transaction, the
 * owner signs it in a wallet or offline, the daemon relays it.
 */
export function OwnerTransaction({ chain, build, onDone, onCancel }: { chain: ChainName; build: () => Promise<RegistrationTxResponse>; onDone: (tx: TxResult) => void; onCancel: () => void }) {
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
    build().then(
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
    // What is built is fixed for the life of this panel.
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

  const usable = signers.filter((s) => s.chain === chain);
  return (
    <section className="notice" aria-label="Owner transaction" style={{ marginTop: 10 }}>
      {busy === 'build' ? <p role="status">The daemon is building the unsigned transaction…</p> : null}
      {built ? (
        <div className="stack" style={{ gap: 8 }}>
          <p>
            <strong>Signing this will:</strong> {built.summary}
          </p>
          <label htmlFor={`${id}-u`} className="muted">
            Unsigned transaction for the owner key on {chainLabel(chain)}
          </label>
          <textarea id={`${id}-u`} readOnly rows={4} value={JSON.stringify(built.unsigned, null, 1)} />
          <div className="row">
            {usable.map((s) => (
              <Button key={s.name} variant="primary" busy={busy === `sign:${s.name}`} onClick={() => void signWith(s)}>
                Sign with {s.name}
              </Button>
            ))}
            {usable.length === 0 ? <span className="muted">No {chainLabel(chain)} wallet was found in this browser. Sign offline with the owner key and paste the result.</span> : null}
          </div>
          <label htmlFor={`${id}-s`}>Signed transaction {chain === 'solana' ? '(base64)' : '(raw, 0x-hex)'}</label>
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


export function TxNotice({ tx }: { tx: TxResult }) {
  return (
    <div style={{ marginTop: 8 }}>
      <Notice tone={tx.status === 'failed' ? 'bad' : 'ok'} title={tx.status === 'failed' ? 'The transaction failed.' : tx.status === 'confirmed' ? 'Relayed and confirmed.' : 'Relayed.'}>
        {tx.error ?? ''} <Id value={tx.id} head={10} tail={8} />
      </Notice>
    </div>
  );
}

