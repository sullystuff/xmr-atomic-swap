/**
 * Instruction builders for every instruction of the program (SPEC 4.3 to 4.5). Data is encoded
 * by the codecs `@xmrswap/protocol` generates from the frozen IDL; account order, signer and
 * writable flags come from the same tables, so a builder cannot drift from the interface.
 *
 * Builders return plain `TransactionInstruction`s. They hold no key and send nothing.
 */
import { PublicKey, SYSVAR_INSTRUCTIONS_PUBKEY, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM,
  type Contact,
  type EthQuoteRefresh,
  INCINERATOR,
  INSTRUCTIONS,
  type InstructionArgs,
  type InstructionName,
  type KeySlot,
  type LockArgs,
  type OfferRefresh,
  type OfferTerms,
  type QuoteTerms,
  type TakeArgs,
  encodeInstructionData,
} from '@xmrswap/protocol';
import { type Bytes, SdkError } from '../util.js';
import { type Key, TOKEN_PROGRAM_ID, ata, configPda, ethBoardPda, makerPda, offerPda, pk, quotePda, swapPda, treasuryPda, treasuryVaultPda, vaultPda } from './pdas.js';

/** The upgradeable loader, owner of the program's ProgramData account (`initialize` checks the upgrade authority there). */
export const BPF_LOADER_UPGRADEABLE = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/**
 * Build one instruction from the frozen tables. `accounts` is keyed by the IDL account name; an
 * absent optional account is passed as the program id (Anchor's convention), an absent required
 * one is an error.
 */
export function buildInstruction<N extends InstructionName>(
  programId: Key,
  name: N,
  args: InstructionArgs[N],
  accounts: Readonly<Record<string, Key | null | undefined>>,
  remaining: { pubkey: Key; isWritable: boolean; isSigner?: boolean }[] = [],
): TransactionInstruction {
  const program = pk(programId);
  const metas = INSTRUCTIONS[name].accounts;
  for (const given of Object.keys(accounts)) if (!metas.some((m) => m.name === given)) throw new SdkError('UnknownAccount', `${name} has no account named ${given}`);
  const keys = metas.map((m) => {
    const given = accounts[m.name];
    if (given === null || given === undefined) {
      if (!m.optional) throw new SdkError('MissingAccount', `${name} needs account ${m.name}`);
      return { pubkey: program, isSigner: false, isWritable: false };
    }
    return { pubkey: pk(given), isSigner: m.signer, isWritable: m.writable };
  });
  for (const r of remaining) keys.push({ pubkey: pk(r.pubkey), isSigner: r.isSigner ?? false, isWritable: r.isWritable });
  return new TransactionInstruction({ programId: program, keys, data: Buffer.from(encodeInstructionData(name, args)) });
}

/** What a settle-list instruction needs to know about the swap and its maker. */
export interface SettleContext {
  /** Swap PDA. */
  swap: Key;
  /** `swap.taker`. */
  taker: Key;
  /** Maker PDA. */
  maker: Key;
  /** `maker.operator` and `maker.payout` from the registry. */
  operator: Key;
  payout: Key;
  /** 0 = SOL, 1 = USDC. */
  asset: number;
  /** 0 = A, 1 = B. */
  direction: number;
  /** `Config.split_mode == 1`: the treasury account is the incinerator. */
  burn?: boolean;
  /**
   * Amendment 1 (SPEC 11.2): `swap.payout`, where a direction-B claim pays. Omit in direction A
   * and for the default (the taker's own wallet).
   */
  swapPayout?: Key | null;
}

/** How a `claim` or `withdraw_owed` fills the three payout slots. */
export interface PayoutSlots {
  /**
   * Pass the associated-token program so a missing token account of the payout address is
   * created at the caller's cost (`rent(165)` more on the caller; otherwise the proceeds park).
   * Default: passed for a USDC swap in direction B, absent otherwise.
   */
  createPayoutToken?: boolean;
}

export type SettleName = 'reject' | 'cancelPending' | 'expirePending' | 'abort' | 'refundUnnoticed' | 'expireUnnoticed' | 'refund' | 'claim' | 'releaseDeposit' | 'splitDeposit' | 'closeSwap' | 'withdrawOwed';
export type ShortName = 'postNotice' | 'setReady' | 'withhold' | 'publishEvidence';

/** Which side a lock or take is opened against: a public offer or a taker-bound `Quote` account. */
export type OpenSource = { offer: true } | { quoteId: bigint; operator: Key };

/** Instruction builders bound to one deployment (program id and USDC mint). */
export class XmrSwapProgram {
  readonly programId: PublicKey;
  readonly usdcMint: PublicKey | null;

  constructor(programId: Key, usdcMint?: Key | null) {
    this.programId = pk(programId);
    this.usdcMint = usdcMint ? pk(usdcMint) : null;
  }

  get config(): PublicKey {
    return configPda(this.programId);
  }
  get treasury(): PublicKey {
    return treasuryPda(this.programId);
  }
  makerPda(owner: Key): PublicKey {
    return makerPda(this.programId, owner);
  }
  offerPda(maker: Key, asset: number, direction: number): PublicKey {
    return offerPda(this.programId, maker, asset, direction);
  }
  swapPda(taker: Key, swapNonce: Bytes): PublicKey {
    return swapPda(this.programId, taker, swapNonce);
  }
  quotePda(maker: Key, quoteId: bigint): PublicKey {
    return quotePda(this.programId, maker, quoteId);
  }
  private mint(): PublicKey {
    if (!this.usdcMint) throw new SdkError('NoUsdcMint', 'a USDC instruction needs the mint of Config.usdc_mint');
    return this.usdcMint;
  }

  // ---------------------------------------------------------------- opening (SPEC 4.4)

  private openAccounts(taker: Key, maker: Key, sessionKey: Key, swapNonce: Bytes, asset: number, direction: number, source: OpenSource, withApproval: boolean) {
    const swap = this.swapPda(taker, swapNonce);
    const usdc = asset === 1;
    return {
      taker,
      swap,
      maker,
      config: this.config,
      session_key: sessionKey,
      system_program: SystemProgram.programId,
      // Exactly one of offer and quote is present; quote_rent_receiver accompanies quote.
      offer: 'offer' in source ? this.offerPda(maker, asset, direction) : null,
      quote: 'offer' in source ? null : this.quotePda(maker, source.quoteId),
      quote_rent_receiver: 'offer' in source ? null : source.operator,
      // Present iff approval_ix is.
      instructions_sysvar: withApproval ? SYSVAR_INSTRUCTIONS_PUBKEY : null,
      // The last four are present for USDC and absent for SOL.
      mint: usdc ? this.mint() : null,
      taker_token: usdc ? ata(taker, this.mint()) : null,
      vault: usdc ? vaultPda(this.programId, swap) : null,
      token_program: usdc ? TOKEN_PROGRAM_ID : null,
    };
  }

  /** `lock` (A1). Signer: the taker's wallet. With `args.approvalIx` set, the same transaction must carry the Ed25519 instruction at that index. */
  lock(p: { taker: Key; maker: Key; sessionKey: Key; source: OpenSource; args: LockArgs }): TransactionInstruction {
    return buildInstruction(this.programId, 'lock', { args: p.args }, this.openAccounts(p.taker, p.maker, p.sessionKey, p.args.swapNonce, p.args.asset, 0, p.source, p.args.approvalIx !== null));
  }

  /** `take` (B1). Signer: the taker's wallet. Only the deposit, the session budget and rent move in. */
  take(p: { taker: Key; maker: Key; sessionKey: Key; source: OpenSource; args: TakeArgs }): TransactionInstruction {
    return buildInstruction(this.programId, 'take', { args: p.args }, this.openAccounts(p.taker, p.maker, p.sessionKey, p.args.swapNonce, p.args.asset, 1, p.source, p.args.approvalIx !== null));
  }

  /** `approve` (A2). Signer: operator. `expectedOpen` binds the approval to the lock it examined (SPEC 3.12). */
  approve(p: { operator: Key; swap: Key; maker: Key; expectedOpen: Bytes; makerSpendPub: Bytes; makerPok: Bytes }): TransactionInstruction {
    return buildInstruction(this.programId, 'approve', { expectedOpen: p.expectedOpen, makerSpendPub: p.makerSpendPub, makerPok: p.makerPok }, { operator: p.operator, swap: p.swap, maker: p.maker, config: this.config });
  }

  /** `fund` (B5). Signer: operator, who pays `amount` (SOL from the signer; USDC from its associated token account). */
  fund(p: { operator: Key; swap: Key; maker: Key; asset: number; expectedOpen: Bytes; makerSpendPub: Bytes; makerPok: Bytes; makerView: Bytes; watcher?: Key | null }): TransactionInstruction {
    const usdc = p.asset === 1;
    return buildInstruction(
      this.programId,
      'fund',
      { expectedOpen: p.expectedOpen, makerSpendPub: p.makerSpendPub, makerPok: p.makerPok, makerView: p.makerView, watcher: p.watcher ? pk(p.watcher).toBase58() : null },
      {
        operator: p.operator,
        swap: p.swap,
        maker: p.maker,
        config: this.config,
        system_program: SystemProgram.programId,
        mint: usdc ? this.mint() : null,
        operator_token: usdc ? ata(p.operator, this.mint()) : null,
        vault: usdc ? vaultPda(this.programId, p.swap) : null,
        token_program: usdc ? TOKEN_PROGRAM_ID : null,
      },
    );
  }

  // ---------------------------------------------------------------- progress and settlement (SPEC 4.5)

  /** An instruction on the Short list: `post_notice`, `set_ready`, `withhold`, `publish_evidence`. */
  short<N extends ShortName>(name: N, p: { caller: Key; swap: Key; maker: Key }, args: InstructionArgs[N]): TransactionInstruction {
    return buildInstruction(this.programId, name, args, { caller: p.caller, swap: p.swap, maker: p.maker, config: this.config });
  }

  /**
   * An instruction on the Settle list. `maker_wallet` is `maker.payout` for a claim in direction
   * A and `maker.operator` otherwise; token destinations are the associated token accounts.
   * For `withdraw_owed`, `destination` replaces the taker (who = 0) or the maker wallet (who = 1).
   *
   * `claim` and `withdraw_owed` carry three more accounts (Amendment 1, SPEC 11.2): the payout
   * address (`swap.payout` in direction B, the taker in A), its token account and, when a
   * missing one should be created, the associated-token program. For `withdraw_owed(0)` of
   * claim proceeds that belong to a payout address, `destination` (honoured only when the
   * payout address itself signs) replaces the payout slots; the taker slots stay the taker's.
   */
  settle<N extends SettleName>(name: N, caller: Key, c: SettleContext, args: InstructionArgs[N], destination?: Key, slots: PayoutSlots = {}): TransactionInstruction {
    const usdc = c.asset === 1;
    let taker = pk(c.taker);
    let makerWallet = pk(name === 'claim' && c.direction === 0 ? c.payout : c.operator);
    const other = c.direction === 1 && c.swapPayout !== null && c.swapPayout !== undefined && !pk(c.swapPayout).equals(taker);
    let payout = c.direction === 1 && c.swapPayout ? pk(c.swapPayout) : taker;
    if (name === 'withdrawOwed') {
      const who = (args as InstructionArgs['withdrawOwed']).who;
      if (who === 1) makerWallet = pk(destination ?? c.payout);
      if (who === 0 && destination) {
        if (other) payout = pk(destination);
        else taker = payout = pk(destination);
      }
    }
    const withPayout = name === 'claim' || name === 'withdrawOwed';
    const create = slots.createPayoutToken ?? (usdc && c.direction === 1);
    return buildInstruction(this.programId, name, args, {
      ...(withPayout ? { payout, payout_token: usdc ? ata(payout, this.mint()) : null, associated_token_program: usdc && create ? ASSOCIATED_TOKEN_PROGRAM : null } : {}),
      caller,
      swap: c.swap,
      maker: c.maker,
      config: this.config,
      taker,
      maker_wallet: makerWallet,
      treasury: c.burn ? INCINERATOR : this.treasury,
      system_program: SystemProgram.programId,
      mint: usdc ? this.mint() : null,
      vault: usdc ? vaultPda(this.programId, c.swap) : null,
      taker_token: usdc ? ata(taker, this.mint()) : null,
      maker_token: usdc ? ata(makerWallet, this.mint()) : null,
      treasury_vault: usdc ? treasuryVaultPda(this.programId, this.mint()) : null,
      token_program: usdc ? TOKEN_PROGRAM_ID : null,
    });
  }

  postNotice(p: { caller: Key; swap: Key; maker: Key; commitment: Bytes; ciphertext: Bytes }): TransactionInstruction {
    if (p.ciphertext.length !== 104) throw new SdkError('BadNotice', 'a notice ciphertext is 104 bytes');
    return this.short('postNotice', p, { commitment: p.commitment, ciphertext: p.ciphertext });
  }
  setReady(p: { caller: Key; swap: Key; maker: Key }): TransactionInstruction {
    return this.short('setReady', p, {});
  }
  /** `freeze` (Z1, SPEC 11.6). Signer: the watcher the swap names, or the locker. NOTICED, before `T_co`, once. Moves nothing. */
  freeze(p: { caller: Key; swap: Key; maker: Key }): TransactionInstruction {
    return buildInstruction(this.programId, 'freeze', {}, { caller: p.caller, swap: p.swap, maker: p.maker, config: this.config });
  }
  /** `withhold`. Direction A with a notice on record: the evidence MUST open the commitment. Otherwise pass `null`. */
  withhold(p: { caller: Key; swap: Key; maker: Key; evidence: { txid: Bytes; view: Bytes } | null }): TransactionInstruction {
    return this.short('withhold', p, { evidence: p.evidence });
  }
  publishEvidence(p: { caller: Key; swap: Key; maker: Key; txid: Bytes; view: Bytes }): TransactionInstruction {
    return this.short('publishEvidence', p, { txid: p.txid, view: p.view });
  }
  reject(caller: Key, c: SettleContext, expectedOpen: Bytes, reason: 0 | 1 | 2): TransactionInstruction {
    return this.settle('reject', caller, c, { expectedOpen, reason });
  }
  /** `refund` (A10, B9). `secret` is the locker's spend share: simulate first, never skip preflight. */
  refund(caller: Key, c: SettleContext, secret: Bytes): TransactionInstruction {
    return this.settle('refund', caller, c, { secret });
  }
  /** `claim` (A11, B10). `secret` is the claimer's spend share. In direction B it pays `c.swapPayout` (SPEC 11.2). */
  claim(caller: Key, c: SettleContext, secret: Bytes, slots: PayoutSlots = {}): TransactionInstruction {
    return this.settle('claim', caller, c, { secret }, undefined, slots);
  }

  // ---------------------------------------------------------------- registry (SPEC 4.3)

  registerMaker(p: { owner: Key; operator: Key; payout: Key; encKey: Bytes }): TransactionInstruction {
    return buildInstruction(this.programId, 'registerMaker', { operator: pk(p.operator).toBase58(), payout: pk(p.payout).toBase58(), encKey: p.encKey }, { owner: p.owner, maker: this.makerPda(p.owner), system_program: SystemProgram.programId });
  }
  setOperator(owner: Key, operator: Key): TransactionInstruction {
    return buildInstruction(this.programId, 'setOperator', { operator: pk(operator).toBase58() }, { owner, maker: this.makerPda(owner) });
  }
  setPayout(owner: Key, payout: Key): TransactionInstruction {
    return buildInstruction(this.programId, 'setPayout', { payout: pk(payout).toBase58() }, { owner, maker: this.makerPda(owner) });
  }
  /** `set_eth_link`: 20 bytes; zeros = unlink. A change takes effect after `LINK_DELAY_SECS`. */
  setEthLink(owner: Key, ethAddress: Bytes): TransactionInstruction {
    if (ethAddress.length !== 20) throw new SdkError('BadAddress', 'an Ethereum address is 20 bytes');
    return buildInstruction(this.programId, 'setEthLink', { ethAddress }, { owner, maker: this.makerPda(owner) });
  }
  setPaused(authority: Key, maker: Key, paused: boolean): TransactionInstruction {
    return buildInstruction(this.programId, 'setPaused', { paused }, { authority, maker });
  }
  bumpEpochs(authority: Key, maker: Key, approvals: boolean, quotes: boolean): TransactionInstruction {
    return buildInstruction(this.programId, 'bumpEpochs', { approvals, quotes }, { authority, maker });
  }
  rotateEncKey(operator: Key, maker: Key, newKey: Bytes, prevExpiresAt: bigint): TransactionInstruction {
    return buildInstruction(this.programId, 'rotateEncKey', { newKey, prevExpiresAt }, { operator, maker });
  }
  setOnion(operator: Key, maker: Key, onion: string): TransactionInstruction {
    return buildInstruction(this.programId, 'setOnion', { onion }, { operator, maker });
  }
  setContacts(operator: Key, maker: Key, contacts: Contact[]): TransactionInstruction {
    return buildInstruction(this.programId, 'setContacts', { contacts }, { operator, maker });
  }
  setInboxPolicy(operator: Key, maker: Key, policy: number): TransactionInstruction {
    return buildInstruction(this.programId, 'setInboxPolicy', { policy }, { operator, maker });
  }
  setOffer(operator: Key, maker: Key, asset: number, direction: number, terms: OfferTerms): TransactionInstruction {
    return buildInstruction(this.programId, 'setOffer', { asset, direction, terms }, { operator, maker, offer: this.offerPda(maker, asset, direction), system_program: SystemProgram.programId });
  }
  /** One transaction refreshes every market: offers travel as remaining accounts in the order of `offers`. */
  refreshOffers(operator: Key, maker: Key, offers: OfferRefresh[], eth: EthQuoteRefresh[] = []): TransactionInstruction {
    return buildInstruction(
      this.programId,
      'refreshOffers',
      { offers, eth },
      { operator, maker, eth_board: eth.length ? ethBoardPda(this.programId, maker) : null },
      offers.map((o) => ({ pubkey: this.offerPda(maker, o.asset, o.direction), isWritable: true })),
    );
  }
  /** `refill_keys`: direction-A offer only; at most 8 slots, each with a proof whose `ctx` is the maker PDA. */
  refillKeys(operator: Key, maker: Key, asset: number, slots: KeySlot[]): TransactionInstruction {
    if (slots.length > 8) throw new SdkError('TooManySlots', 'refill_keys takes at most 8 slots');
    return buildInstruction(this.programId, 'refillKeys', { asset, slots }, { operator, maker, offer: this.offerPda(maker, asset, 0) });
  }
  setEthQuote(operator: Key, maker: Key, slot: number, quote: Bytes, sig: Bytes): TransactionInstruction {
    return buildInstruction(this.programId, 'setEthQuote', { slot, quote, sig }, { operator, maker, eth_board: ethBoardPda(this.programId, maker), system_program: SystemProgram.programId });
  }
  postQuote(operator: Key, maker: Key, terms: QuoteTerms): TransactionInstruction {
    return buildInstruction(this.programId, 'postQuote', { terms }, { operator, maker, quote: this.quotePda(maker, terms.quoteId), system_program: SystemProgram.programId });
  }
  cancelQuote(caller: Key, maker: Key, quoteId: bigint, operator: Key): TransactionInstruction {
    return buildInstruction(this.programId, 'cancelQuote', {}, { caller, maker, quote: this.quotePda(maker, quoteId), quote_rent_receiver: operator });
  }
  /**
   * `post_message`: the envelope is the instruction data; nothing is written or emitted. The
   * recipient is the maker PDA (to a maker) or the taker's wallet (to a taker). Cap 900 bytes.
   */
  postMessage(sender: Key, recipient: Key, payload: Bytes, swap?: Key | null): TransactionInstruction {
    if (payload.length > 900) throw new SdkError('MessageTooLarge', `${payload.length} bytes is over the 900-byte on-chain cap`);
    return buildInstruction(this.programId, 'postMessage', { payload }, { sender, recipient, swap: swap ?? null });
  }

  // ---------------------------------------------------------------- admin (tests and the owner's tooling)

  /** `set_caps` (SPEC 11.1). Admin. Per asset: index 0 SOL, 1 USDC. A fresh deployment opens nothing until this is called. */
  setCaps(admin: Key, p: { capsOn: boolean; maxSwap: [bigint, bigint]; maxOpen: [bigint, bigint] }): TransactionInstruction {
    return buildInstruction(this.programId, 'setCaps', { capsOn: p.capsOn, maxSwap: p.maxSwap, maxOpen: p.maxOpen }, { admin, config: this.config });
  }

  initialize(p: { authority: Key; usdcMint: Key; clusterTag: Bytes; treasuryAuthority: Key; splitMode: number }): TransactionInstruction {
    const programData = PublicKey.findProgramAddressSync([this.programId.toBytes()], BPF_LOADER_UPGRADEABLE)[0];
    return buildInstruction(
      this.programId,
      'initialize',
      { clusterTag: p.clusterTag, treasuryAuthority: pk(p.treasuryAuthority).toBase58(), splitMode: p.splitMode },
      {
        authority: p.authority,
        config: this.config,
        treasury: this.treasury,
        usdc_mint: p.usdcMint,
        treasury_vault: treasuryVaultPda(this.programId, p.usdcMint),
        program: this.programId,
        program_data: programData,
        token_program: TOKEN_PROGRAM_ID,
        system_program: SystemProgram.programId,
      },
    );
  }
}
