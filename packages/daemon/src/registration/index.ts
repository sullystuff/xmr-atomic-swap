/**
 * Registration manager (DESIGN "Maker tools", "Shared maker identity"; SPEC 7.1
 * `registration/`). Owner-key actions (register, operator, payout, the identity link, the
 * owner's pause) are built as UNSIGNED transactions for the console to sign with the owner's
 * wallet; the daemon never holds a cold owner key. Operator-key settings (onion address,
 * contact channels, inbox policy) are sent by the daemon itself.
 */
import { randomBytes } from 'node:crypto';
import { createAssociatedTokenAccountIdempotentInstruction } from '@solana/spl-token';
import { PublicKey, Transaction, type TransactionInstruction } from '@solana/web3.js';
import { CONTACT_KIND, type Contact, base58Decode } from '@xmrswap/protocol';
import type { EthereumRegistration, LinkStatus, RegistrationAction, RegistrationResponse, RegistrationTxResponse, SolanaRegistration, TxResult, UnsignedTransaction } from '@xmrswap/protocol/daemon-api';
import { type EthCall, type SwapView, ata, bytesEqual, solanaInstruction, effectiveEthLink, effectiveSolanaLink, hex0x, linkStatus, unhex } from '@xmrswap/sdk';
import type { EthereumChain } from '../chains/ethereum.js';
import type { SolanaChain } from '../chains/solana.js';
import type { EncKeys } from '../rotation/index.js';
import type { Journal } from '../store/journal.js';

export interface RegistrationOptions {
  solana: () => SolanaChain | null;
  ethereum: () => EthereumChain | null;
  /** The owner keys the configuration names (public). */
  solanaOwner: () => string | null;
  ethereumOwner: () => string | null;
  ethereumChainId: () => number | null;
  encKeys: EncKeys;
  journal: Journal;
  live: () => boolean;
  /** What should be published: the onion host (or `null`), the contact channels and the inbox policy. */
  desired: () => { onion: string | null; contacts: Contact[]; inboxPolicy: 'open' | 'swap_only' };
}

const zero = (b: Uint8Array): boolean => b.every((x) => x === 0);

export class Registration {
  private pending = new Map<string, { chain: 'solana' | 'ethereum'; message?: Buffer; call?: EthCall }>();

  constructor(private readonly o: RegistrationOptions) {}

  /** Both registrations and the link between them. */
  async status(): Promise<RegistrationResponse> {
    const sol = this.o.solana();
    const eth = this.o.ethereum();
    const noLink: LinkStatus = { current: null, pending: null, pending_effective_at: null, mutual: false };
    let solana: SolanaRegistration = { registered: false, maker: sol?.makerPda ?? null, owner: this.o.solanaOwner(), operator: null, payout: null, payout_usdc_account: null, enc_key_version: null, onion: null, contacts: [], inbox_policy: null, link: noLink };
    let ethereum: EthereumRegistration = { registered: false, maker: this.o.ethereumOwner(), operator: null, payout: null, quote_epoch: null, approval_epoch: null, link: noLink };
    const sm = sol ? await sol.client.getMaker(sol.makerPda, 'finalized') : null;
    const em = eth ? await eth.client.getMaker(eth.makerAddress, eth.tag) : null;
    const [solNow, ethNow] = await Promise.all([sol ? sol.now() : 0n, eth ? eth.now() : 0n]);
    const mutual = sm && em && eth ? linkStatus(sm, { address: eth.makerAddress, solanaOwner: em.solanaOwner, solanaOwnerNext: em.solanaOwnerNext, solanaOwnerNextAt: em.solanaOwnerNextAt }, solNow, ethNow).status === 'mutual' : false;
    if (sol && sm) {
      const usdc = sol.client.program.usdcMint;
      const payoutUsdc = usdc ? (await sol.client.transport.getAccount(ata(sm.payout, usdc).toBase58())) !== null : null;
      const cur = effectiveEthLink(sm, solNow);
      solana = {
        registered: true, maker: sol.makerPda, owner: sm.owner, operator: sm.operator, payout: sm.payout, payout_usdc_account: payoutUsdc, enc_key_version: sm.encKeyVersion, onion: sm.onion || null,
        contacts: sm.contacts.map((c) => ({ kind: c.kind, value: c.value })), inbox_policy: sm.inboxPolicy === 1 ? 'swap_only' : 'open',
        link: { current: cur ? hex0x(cur) : null, pending: sm.ethLinkNextAt !== 0n && solNow < sm.ethLinkNextAt ? hex0x(sm.ethLinkNext) : null, pending_effective_at: sm.ethLinkNextAt !== 0n && solNow < sm.ethLinkNextAt ? Number(sm.ethLinkNextAt) : null, mutual },
      };
    }
    if (eth && em) {
      const link = { address: eth.makerAddress, solanaOwner: em.solanaOwner, solanaOwnerNext: em.solanaOwnerNext, solanaOwnerNextAt: em.solanaOwnerNextAt };
      const cur = effectiveSolanaLink(link, ethNow);
      const pendingNow = em.solanaOwnerNextAt !== 0n && ethNow < em.solanaOwnerNextAt;
      ethereum = {
        registered: true, maker: eth.makerAddress, operator: em.operator, payout: em.payout, quote_epoch: em.quoteEpoch, approval_epoch: em.approvalEpoch,
        link: { current: cur && !zero(cur) ? new PublicKey(cur).toBase58() : null, pending: pendingNow ? new PublicKey(unhex(em.solanaOwnerNext)).toBase58() : null, pending_effective_at: pendingNow ? Number(em.solanaOwnerNextAt) : null, mutual },
      };
    }
    const blob = !!solana.onion || solana.contacts.some((c) => c.kind === CONTACT_KIND.BLOB_ENDPOINT);
    return { solana, ethereum, blob_endpoint: blob };
  }

  /** Build an owner-key action as an unsigned transaction for the console to sign. Nothing is sent. */
  async buildTx(a: RegistrationAction): Promise<RegistrationTxResponse> {
    const requestId = randomBytes(16).toString('hex');
    if (a.chain === 'solana') {
      const sol = this.o.solana();
      const owner = a.action === 'register_maker' ? a.owner : this.o.solanaOwner();
      if (!sol || !owner) throw new Error('Solana is not configured (the RPC endpoint and solana.maker_owner are needed)');
      const p = sol.client.program;
      let ix;
      let summary: string;
      switch (a.action) {
        case 'register_maker':
          // The first encryption key is generated and stored before it is named in the registration.
          ix = p.registerMaker({ owner: a.owner, operator: a.operator, payout: a.payout, encKey: this.o.encKeys.ensure(1) });
          summary = `Register this maker on Solana: operator ${a.operator}, payout ${a.payout}. The owner key signs; the daemon holds only the operator key.`;
          break;
        case 'set_operator':
          ix = p.setOperator(owner, a.operator);
          summary = `Change the operator (hot) key to ${a.operator}. Every outstanding advance approval dies with the old key.`;
          break;
        case 'set_payout':
          ix = p.setPayout(owner, a.payout);
          summary = `Pay direction-A claims to ${a.payout} from now on.`;
          break;
        case 'set_eth_link':
          ix = p.setEthLink(owner, unhex(a.eth_address));
          summary = `Point this Solana record at the Ethereum maker ${a.eth_address}. The first link is immediate; a change or removal takes 7 days. The link counts only once the Ethereum record points back.`;
          break;
        case 'set_paused':
          ix = p.setPaused(owner, sol.makerPda, a.paused);
          summary = a.paused ? 'Pause the maker with the owner key: no new swaps on Solana.' : "Lift the owner's pause on Solana.";
          break;
      }
      const { blockhash } = await sol.client.transport.getLatestBlockhash();
      const tx = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: blockhash }).add(ix);
      const message = tx.serializeMessage();
      this.pending.set(requestId, { chain: 'solana', message });
      const unsigned: UnsignedTransaction = { chain: 'solana', message_b64: message.toString('base64'), recent_blockhash: blockhash, fee_payer: owner };
      return { request_id: requestId, unsigned, summary };
    }
    const eth = this.o.ethereum();
    const chainId = this.o.ethereumChainId();
    if (!eth || chainId === null) throw new Error('Ethereum is not configured (the RPC endpoint, contract and chain_id are needed)');
    const c = eth.client.contract;
    let call: EthCall;
    let summary: string;
    switch (a.action) {
      case 'register_maker':
        call = c.registerMaker(a.operator as `0x${string}`, a.payout as `0x${string}`, base58Decode(a.solana_owner));
        summary = `Register this maker on Ethereum: operator ${a.operator}, payout ${a.payout}, linked to the Solana owner ${a.solana_owner}.`;
        break;
      case 'set_operator':
        call = c.setOperator(a.operator as `0x${string}`);
        summary = `Change the Ethereum operator key to ${a.operator}.`;
        break;
      case 'set_payout':
        call = c.setPayout(a.payout as `0x${string}`);
        summary = `Pay direction-A claims on Ethereum to ${a.payout}.`;
        break;
      case 'set_solana_link':
        call = c.setSolanaLink(base58Decode(a.solana_owner));
        summary = `Point this Ethereum record at the Solana owner ${a.solana_owner}. A change or removal takes 7 days.`;
        break;
      case 'set_paused':
        call = c.setPaused(a.paused);
        summary = a.paused ? 'Pause the maker on Ethereum: no new swaps.' : 'Lift the pause on Ethereum.';
        break;
    }
    this.pending.set(requestId, { chain: 'ethereum', call });
    return { request_id: requestId, unsigned: { chain: 'ethereum', chain_id: chainId, to: call.to, data: call.data, value: call.value.toString() }, summary };
  }

  /**
   * A parked payout is pulled by the account it is owed to, which is never a key the daemon
   * would use for that (the cold owner on Solana; payout, operator or owner on Ethereum). Built
   * unsigned, like the registration actions, and submitted through the same route.
   */
  async buildWithdrawOwed(view: SwapView): Promise<RegistrationTxResponse> {
    const requestId = randomBytes(16).toString('hex');
    if (view.chain === 'solana') {
      const sol = this.o.solana();
      const owner = this.o.solanaOwner();
      if (!sol || !owner) throw new Error('Solana is not configured');
      if (view.owedMaker === 0n) throw new Error('nothing is parked for the maker on this swap');
      const m = await sol.maker(true);
      const ix = solanaInstruction(sol.client.program, view, { operator: m.operator, payout: m.payout }, owner, { name: 'withdraw_owed', who: 'maker' });
      const { blockhash } = await sol.client.transport.getLatestBlockhash();
      const message = new Transaction({ feePayer: new PublicKey(owner), recentBlockhash: blockhash }).add(ix).serializeMessage();
      this.pending.set(requestId, { chain: 'solana', message });
      return { request_id: requestId, ...({ account: owner, role: 'owner' } as object), unsigned: { chain: 'solana', message_b64: message.toString('base64'), recent_blockhash: blockhash, fee_payer: owner }, summary: `Withdraw the payout parked for the maker on this swap (${view.owedMaker} base units) with the owner key.` };
    }
    const eth = this.o.ethereum();
    const chainId = this.o.ethereumChainId();
    if (!eth || chainId === null) throw new Error('Ethereum is not configured');
    const owed = await eth.client.owedFor(view.asset as `0x${string}`, view.taker as `0x${string}`, view.maker as `0x${string}`, eth.tag);
    const who = owed.accounts ? ([['payout', owed.payout], ['operator', owed.operator], ['owner', owed.owner]] as const).find(([, v]) => v > 0n) : undefined;
    if (!who || !owed.accounts) throw new Error('nothing is parked for the maker on this token');
    const account = owed.accounts[who[0]];
    const call = eth.client.contract.withdrawOwed(view.asset as `0x${string}`, account);
    this.pending.set(requestId, { chain: 'ethereum', call });
    return { request_id: requestId, ...({ account, role: who[0] } as object), unsigned: { chain: 'ethereum', chain_id: chainId, to: call.to, data: call.data, value: '0' }, summary: `Withdraw ${who[1]} base units parked for the maker's ${who[0]} address ${account}. It must be signed by THAT address: parked payouts are keyed by the account they were owed to.` };
  }

  /** Relay a transaction the owner's wallet signed. Solana: it must be the message this daemon built, so the route is not an open relay. */
  async submit(requestId: string, signed: string): Promise<TxResult> {
    const p = this.pending.get(requestId);
    if (!p) throw new Error('unknown or expired request_id');
    if (p.chain === 'solana') {
      const sol = this.o.solana();
      if (!sol) throw new Error('Solana is not configured');
      const wire = Buffer.from(signed, 'base64');
      const tx = Transaction.from(wire);
      if (!bytesEqual(Uint8Array.from(tx.serializeMessage()), Uint8Array.from(p.message!))) throw new Error('the signed transaction is not the one this daemon built');
      if (!tx.verifySignatures(true)) throw new Error('the transaction is not fully signed');
      const id = await sol.client.submit(Uint8Array.from(wire));
      this.pending.delete(requestId);
      return { chain: 'solana', id, status: 'sent' };
    }
    const eth = this.o.ethereum();
    if (!eth) throw new Error('Ethereum is not configured');
    if (!/^0x[0-9a-fA-F]+$/.test(signed)) throw new Error('an Ethereum raw transaction is 0x-hex');
    const id = (await eth.client.transport.request({ method: 'eth_sendRawTransaction', params: [signed] })) as string;
    this.pending.delete(requestId);
    return { chain: 'ethereum', id, status: 'sent' };
  }

  /**
   * Bring the operator-signed part of the Solana record in line with the configuration: the
   * onion address, the contact channels and the inbox policy; and make sure the payout's USDC
   * token account exists (payouts never create one). One transaction when something changed.
   */
  async syncPublished(): Promise<string | null> {
    const sol = this.o.solana();
    if (!sol || !this.o.live()) return null;
    const m = await sol.client.getMaker(sol.makerPda, 'finalized');
    if (!m) return null;
    const want = this.o.desired();
    const p = sol.client.program;
    const ixs: TransactionInstruction[] = [];
    const calls: string[] = [];
    if (want.onion !== null && want.onion !== m.onion) {
      ixs.push(p.setOnion(sol.operator, sol.makerPda, want.onion));
      calls.push('set_onion');
    }
    const sameContacts = want.contacts.length === m.contacts.length && want.contacts.every((c, i) => c.kind === m.contacts[i]!.kind && c.value === m.contacts[i]!.value);
    if (!sameContacts) {
      ixs.push(p.setContacts(sol.operator, sol.makerPda, want.contacts));
      calls.push('set_contacts');
    }
    const policy = want.inboxPolicy === 'swap_only' ? 1 : 0;
    if (policy !== m.inboxPolicy) {
      ixs.push(p.setInboxPolicy(sol.operator, sol.makerPda, policy));
      calls.push('set_inbox_policy');
    }
    const usdc = p.usdcMint;
    if (usdc && (await sol.client.transport.getAccount(ata(m.payout, usdc).toBase58())) === null) {
      ixs.push(createAssociatedTokenAccountIdempotentInstruction(new PublicKey(sol.operator), ata(m.payout, usdc), new PublicKey(m.payout), usdc));
      calls.push('create_payout_token_account');
    }
    if (ixs.length === 0) return null;
    const { tx } = await this.o.journal.broadcast('sol_tx', null, { call: calls.join('+') }, (onSigned) => sol.sendInstructions(ixs, onSigned));
    return tx;
  }
}
