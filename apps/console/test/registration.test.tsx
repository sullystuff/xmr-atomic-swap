import { act, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ADDR } from '../src/mock/fixtures.js';
import { fromBase64, requiredSignatures, toBase64, unsignedSolanaTransaction, watchSigners, type OwnerSigner } from '../src/lib/wallet.js';
import { mount, text } from './harness.js';

const NEW_ETH = '0x00000000000000000000000000000000000000aa';
/** What an offline signer would return: any well-formed base64 transaction. */
const SIGNED_SOL = toBase64(new Uint8Array(160).fill(7));
const SIGNED_ETH = `0x02${'ab'.repeat(110)}`;

describe('registration page', () => {
  it('shows both registrations with owner, operator and payout', async () => {
    mount('#/registration');
    const sol = await screen.findByRole('region', { name: 'Solana registration' });
    expect(text(sol)).toContain('Registered');
    expect(text(sol)).toContain(`Owner (cold)${ADDR.solOwner}`);
    expect(text(sol)).toContain(`Operator (hot)${ADDR.solOperator}`);
    expect(text(sol)).toContain(`Payout${ADDR.solPayout}its USDC token account exists`);
    expect(text(sol)).toContain('Encryption keyversion 7');
    const eth = screen.getByRole('region', { name: 'Ethereum registration' });
    expect(text(eth)).toContain(`Maker (owner)${ADDR.ethOwner}`);
    expect(text(eth)).toContain(`Operator (hot)${ADDR.ethOperator}`);
    expect(text(eth)).toContain('Epochsquote 3 · approval 2');
    expect(text(screen.getByRole('main'))).toContain('The owner key never touches this console or the daemon.');
  });

  it('shows the identity link as mutual, with its delay and trace rules', async () => {
    mount('#/registration');
    const link = await screen.findByRole('region', { name: 'Identity link' });
    expect(text(link)).toContain('Linked both ways');
    expect(text(within(link).getByTestId('link-state'))).toBe(
      'Both records point at each other, each written by its own chain’s key. Takers see one profile with the history of both chains combined, and a fault on either chain counts against the whole identity.',
    );
    expect(text(link)).toContain(`Points at${ADDR.ethOwner}`);
    expect(text(link)).toContain(`Points at${ADDR.solOwner}`);
    expect(text(link)).toContain(
      'Changing or removing a link leaves a trace. The first link takes effect at once. Any later change or removal is a recorded on-chain event and takes effect only after 7 days. Clients keep past history attached to both keys, so unlinking does not shed a bad record. Each key links to at most one counterpart.',
    );
  });

  it('changes a link through an owner transaction and shows the pending change with its 7-day delay', async () => {
    const m = mount('#/registration');
    const link = await screen.findByRole('region', { name: 'Identity link' });
    await m.user.type(within(link).getByLabelText('Ethereum address to point at'), NEW_ETH);
    await m.user.click(within(link).getByRole('button', { name: 'Change the Solana pointer' }));

    const panel = await within(link).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    expect(text(panel)).toContain(`Signing this will: Point the Solana record at the Ethereum address ${NEW_ETH}. A change takes effect after 7 days and stays on record.`);
    // The unsigned transaction is shown for the owner key to sign; nothing here holds that key.
    const unsigned = JSON.parse((within(panel).getByLabelText('Unsigned transaction for the owner key on Solana') as HTMLTextAreaElement).value) as { chain: string; fee_payer: string; message_b64: string };
    expect(unsigned.chain).toBe('solana');
    expect(unsigned.fee_payer).toBe(ADDR.solOwner);
    expect(text(panel)).toContain('No Solana wallet was found in this browser. Sign offline with the owner key and paste the result.');
    const relay = within(panel).getByRole('button', { name: 'Relay the signed transaction' }) as HTMLButtonElement;
    expect(relay.disabled).toBe(true);

    // A malformed paste is refused by the daemon and nothing changes.
    await m.user.type(within(panel).getByLabelText('Signed transaction (base64)'), 'nonsense');
    await m.user.click(relay);
    expect(text(await within(panel).findByRole('alert'))).toContain('Expected a signed Solana transaction in base64.');
    expect((await m.client.call('registration')).solana.link.pending).toBeNull();

    await m.user.clear(within(panel).getByLabelText('Signed transaction (base64)'));
    await m.user.type(within(panel).getByLabelText('Signed transaction (base64)'), SIGNED_SOL);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    expect(await within(link).findByText('Relayed and confirmed.')).toBeTruthy();

    await waitFor(() => expect(text(link)).toContain(`Pending changePending ${NEW_ETH}`));
    expect(text(link)).toContain('Takes effect in7d 0h');
    // Until then the old link stays in force and stays mutual.
    expect(text(link)).toContain('Linked both ways');
    const reg = await m.client.call('registration');
    expect(reg.solana.link).toMatchObject({ current: ADDR.ethOwner, pending: NEW_ETH, pending_effective_at: m.now() + 604_800, mutual: true });

    // After the delay the pointer changes, and a one-sided link is called what it is.
    m.advance(604_800);
    await m.client.call('registration');
    window.location.hash = '#/status';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    window.location.hash = '#/registration';
    act(() => void window.dispatchEvent(new HashChangeEvent('hashchange')));
    const after = await screen.findByRole('region', { name: 'Identity link' });
    await waitFor(() => expect(text(after)).toContain('One-sided'));
    expect(text(within(after).getByTestId('link-state'))).toContain('A pointer in one direction is ignored: clients show two separate makers until both records agree.');
  });

  it('removes a link only after stating that it leaves a trace', async () => {
    const m = mount('#/registration');
    const link = await screen.findByRole('region', { name: 'Identity link' });
    await m.user.click(within(link).getByRole('button', { name: 'Remove the Ethereum pointer' }));
    expect(text(within(link).getByRole('alertdialog'))).toContain('The removal is recorded on chain, takes effect after 7 days, and past history stays attached to both keys.');
    await m.user.click(within(within(link).getByRole('alertdialog')).getByRole('button', { name: 'Remove the Ethereum pointer' }));
    const panel = await within(link).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    expect(text(panel)).toContain('Remove the link from the Ethereum record to Solana. It takes effect after 7 days and stays on record.');
    await m.user.type(within(panel).getByLabelText('Signed transaction (raw, 0x-hex)'), SIGNED_ETH);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    await waitFor(() => expect(text(link)).toContain('Pending changePending remove the link'));
    expect((await m.client.call('registration')).ethereum.link).toMatchObject({ current: ADDR.solOwner, pending: '', pending_effective_at: m.now() + 604_800 });
  });

  it('registers on Solana first; Ethereum is refused until then', async () => {
    const m = mount('#/registration', {
      prepare: (d) =>
        d.setRegistration((r) => {
          Object.assign(r.solana, { registered: false, maker: null, owner: null, operator: null, payout: null });
          Object.assign(r.ethereum, { registered: false, maker: null, operator: null, payout: null });
          r.solana.link = { current: null, pending: null, pending_effective_at: null, mutual: false };
          r.ethereum.link = { current: null, pending: null, pending_effective_at: null, mutual: false };
        }),
    });
    const eth = await screen.findByRole('region', { name: 'Ethereum registration' });
    expect(text(eth)).toContain('Not registered');
    expect((within(eth).getByRole('button', { name: 'Register on Ethereum' }) as HTMLButtonElement).disabled).toBe(true);
    expect((within(eth).getByLabelText('Owner address (cold)') as HTMLInputElement).disabled).toBe(true);
    expect(text(eth)).toContain('Register on Solana first: every maker registers there, including Ethereum-only makers.');
    expect(text(screen.getByRole('region', { name: 'Identity link' }))).toContain('Not linked');

    const sol = screen.getByRole('region', { name: 'Solana registration' });
    await m.user.type(within(sol).getByLabelText('Owner key (cold)'), 'OwnerKeyExample1111');
    await m.user.type(within(sol).getByLabelText('Operator key (hot)'), 'OperatorKeyExample1111');
    await m.user.type(within(sol).getByLabelText('Payout address'), 'PayoutExample1111');
    await m.user.click(within(sol).getByRole('button', { name: 'Register on Solana' }));
    const panel = await within(sol).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    expect(text(panel)).toContain('Register this maker on Solana with operator OperatorKeyExample1111 and payout PayoutExample1111.');
    await m.user.type(within(panel).getByLabelText('Signed transaction (base64)'), SIGNED_SOL);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Solana registration' }))).toContain('Owner (cold)OwnerKeyExample1111'));
    await waitFor(() => expect((within(screen.getByRole('region', { name: 'Ethereum registration' })).getByRole('button', { name: 'Register on Ethereum' }) as HTMLButtonElement).disabled).toBe(true));
    expect((within(screen.getByRole('region', { name: 'Ethereum registration' })).getByLabelText('Owner address (cold)') as HTMLInputElement).disabled).toBe(false);
  });

  it('changes the operator key on Ethereum', async () => {
    const m = mount('#/registration');
    const eth = await screen.findByRole('region', { name: 'Ethereum registration' });
    await m.user.type(within(eth).getByLabelText('New operator address'), NEW_ETH);
    await m.user.click(within(eth).getByRole('button', { name: 'Change operator' }));
    const panel = await within(eth).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    const unsigned = JSON.parse((within(panel).getByLabelText('Unsigned transaction for the owner key on Ethereum') as HTMLTextAreaElement).value) as { chain: string; chain_id: number; to: string; value: string };
    expect(unsigned).toMatchObject({ chain: 'ethereum', chain_id: 1, to: ADDR.contract, value: '0' });
    await m.user.type(within(panel).getByLabelText('Signed transaction (raw, 0x-hex)'), SIGNED_ETH);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Ethereum registration' }))).toContain(`Operator (hot)${NEW_ETH}`));
  });

  it('signs with the owner’s Solana wallet when one is present, without the console holding a key', async () => {
    const seen: { account: string; bytes: Uint8Array }[] = [];
    const wallet = {
      name: 'Test Wallet',
      accounts: [{ address: ADDR.solOwner }],
      features: {
        'solana:signTransaction': {
          signTransaction: async (input: { account: { address: string }; transaction: Uint8Array }) => {
            seen.push({ account: input.account.address, bytes: input.transaction });
            const signed = new Uint8Array(input.transaction);
            signed.fill(9, 1, 65); // the wallet fills in the signature
            return [{ signedTransaction: signed }];
          },
        },
      },
    };
    const announce = (e: Event): void => (e as CustomEvent<{ register: (w: unknown) => void }>).detail.register(wallet);
    window.addEventListener('wallet-standard:app-ready', announce);
    try {
      const m = mount('#/registration');
      const sol = await screen.findByRole('region', { name: 'Solana registration' });
      await m.user.type(within(sol).getByLabelText('New payout address'), 'NewPayoutExample1111');
      await m.user.click(within(sol).getByRole('button', { name: 'Change payout' }));
      const panel = await within(sol).findByRole('region', { name: 'Owner transaction' });
      await m.user.click(await within(panel).findByRole('button', { name: 'Sign with Test Wallet' }));
      await waitFor(() => expect(text(screen.getByRole('region', { name: 'Solana registration' }))).toContain('PayoutNewPayoutExample1111'));
      expect(seen).toHaveLength(1);
      expect(seen[0]?.account).toBe(ADDR.solOwner);
      // One signature slot, empty, then the daemon's message untouched.
      const bytes = seen[0]?.bytes as Uint8Array;
      expect(bytes[0]).toBe(1);
      expect([...bytes.slice(1, 65)].every((b) => b === 0)).toBe(true);
      expect(bytes.length).toBe(1 + 64 + 96);
    } finally {
      window.removeEventListener('wallet-standard:app-ready', announce);
    }
  });

  it('pauses with the owner key through the same sign-and-relay path', async () => {
    const m = mount('#/registration');
    const card = await screen.findByRole('region', { name: 'Owner pause' });
    await waitFor(() => expect(text(card)).toContain('Not paused by the owner key'));
    await m.user.click(within(card).getByRole('button', { name: 'Pause on Solana' }));
    await m.user.click(within(within(card).getByRole('alertdialog')).getByRole('button', { name: 'Pause on Solana' }));
    const panel = await within(card).findByRole('region', { name: 'Owner transaction' });
    await within(panel).findByText('Signing this will:');
    expect(text(panel)).toContain('Pause this maker on Solana with the owner key.');
    await m.user.type(within(panel).getByLabelText('Signed transaction (base64)'), SIGNED_SOL);
    await m.user.click(within(panel).getByRole('button', { name: 'Relay the signed transaction' }));
    await waitFor(() => expect(text(screen.getByRole('region', { name: 'Owner pause' }))).toContain('Paused by the owner key'));
    expect((await m.client.call('status')).paused.owner).toBe(true);
    expect(text(screen.getByRole('banner'))).toContain('Paused by the owner key');
  });

  it('shows the contact channels, the inbox policy and whether a blob endpoint is listed', async () => {
    mount('#/registration', { blobEndpoint: false });
    const card = await screen.findByRole('region', { name: 'Contact channels' });
    expect(text(card)).toContain('Onion addressnone listed: takers reach you over on-chain messaging');
    expect(text(card)).toContain('InboxOpen to anyone (each message costs the sender a transaction fee)');
    expect(text(card)).toContain('Blob endpointNot listed Ethereum markets cannot be enabled without one');
    expect(text(card)).toContain('Matrix: #maker-desk:example.org');
    expect(text(card)).toContain('Email: desk@example.org');
    expect(text(card)).toContain('Takers see these labelled as provided by you and not verified.');
  });
});

describe('owner wallet signing', () => {
  it('wraps a legacy and a v0 message as an unsigned transaction', () => {
    const legacy = new Uint8Array([2, 0, 1, 5, 6, 7]);
    const tx = unsignedSolanaTransaction(toBase64(legacy));
    expect(tx.length).toBe(1 + 128 + legacy.length);
    expect(tx[0]).toBe(2);
    expect([...tx.slice(129)]).toEqual([...legacy]);
    expect(requiredSignatures(new Uint8Array([0x80, 1, 0, 0]))).toBe(1);
    expect(() => requiredSignatures(new Uint8Array([]))).toThrow();
    expect(() => requiredSignatures(new Uint8Array([0]))).toThrow();
    expect([...fromBase64(toBase64(legacy))]).toEqual([...legacy]);
  });

  it('refuses a wallet that does not hold the owner key', async () => {
    const win = new EventTarget() as unknown as Window;
    let signers: OwnerSigner[] = [];
    const stop = watchSigners((s) => (signers = s), win);
    win.dispatchEvent(
      new CustomEvent('wallet-standard:register-wallet', {
        detail: (api: { register: (w: unknown) => void }) =>
          api.register({ name: 'Other Wallet', accounts: [{ address: 'SomeoneElse' }], features: { 'solana:signTransaction': { signTransaction: async () => [] } } }),
      }),
    );
    expect(signers.map((s) => `${s.chain}:${s.name}`)).toEqual(['solana:Other Wallet']);
    await expect(signers[0]?.sign({ chain: 'solana', message_b64: toBase64(new Uint8Array([1, 0, 0, 9])), recent_blockhash: 'x', fee_payer: 'TheOwner' })).rejects.toThrow('Other Wallet does not hold the owner key TheOwner');
    stop();
  });

  it('asks an Ethereum wallet for a signature only, and explains a wallet that will not give one', async () => {
    const calls: string[] = [];
    const provider = {
      request: async ({ method }: { method: string }): Promise<unknown> => {
        calls.push(method);
        if (method === 'eth_requestAccounts') return ['0x00000000000000000000000000000000000000cc'];
        if (method === 'eth_chainId') return '0x1';
        if (method === 'eth_signTransaction') return '0x02abcdef';
        throw new Error(`unexpected ${method}`);
      },
    };
    const win = Object.assign(new EventTarget(), { ethereum: provider }) as unknown as Window;
    let signers: OwnerSigner[] = [];
    watchSigners((s) => (signers = s), win)();
    const eth = signers.find((s) => s.chain === 'ethereum') as OwnerSigner;
    const unsigned = { chain: 'ethereum' as const, chain_id: 1, to: '0x01', data: '0x', value: '0' };
    expect(await eth.sign(unsigned)).toBe('0x02abcdef');
    // It never asks the wallet to broadcast: the daemon relays.
    expect(calls).toEqual(['eth_requestAccounts', 'eth_chainId', 'eth_signTransaction']);
    await expect(eth.sign({ ...unsigned, chain_id: 5 })).rejects.toThrow('The wallet is on chain 1; this transaction is for chain 5.');

    provider.request = async ({ method }) => {
      if (method === 'eth_requestAccounts') return ['0x00000000000000000000000000000000000000cc'];
      if (method === 'eth_chainId') return '0x1';
      throw Object.assign(new Error('unsupported'), { code: 4200 });
    };
    await expect(eth.sign(unsigned)).rejects.toThrow('This wallet will not sign without broadcasting.');
  });
});
