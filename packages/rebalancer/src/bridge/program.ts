/**
 * wXMR bridge program: constants, PDAs, instruction encoders and account/event decoders.
 *
 * Built from the facts in docs/research/local-assets.md section 3 and SPEC 7.7, NOT from the
 * bridge's IDL, which the project owner has yet to place at `vendor/wxmr_bridge.json`.
 * `LAYOUT` below is the single table the encoders, the decoders and the IDL-conformance test
 * all read; `BRIDGE-ASSUMPTIONS.md` is its prose form.
 */
import { createHash } from 'node:crypto';
import { PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';

export const BRIDGE_PROGRAM_ID = new PublicKey('EzBkC8P5wxab9kwrtV5hRdynHAfB5w3UPcPXNgMseVA8');
export const WXMR_MINT = new PublicKey('WXMRyRZhsa19ety5erZhHg4N3xj3EVN92u94422teJp');
export const WXMR_DECIMALS = 12;
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
export const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
export const WSOL_MINT = new PublicKey('So11111111111111111111111111111111111111112');
export const BPF_UPGRADEABLE_LOADER_ID = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** 0.1 XMR, each way. */
export const BRIDGE_MIN_ATOMIC = 100_000_000_000n;
export const DEPOSIT_FEE_BPS = 10n;
export const DEFAULT_WITHDRAW_FEE_BPS = 10;
export const CANCEL_DELAY_SECONDS = 300;
export const HEARTBEAT_MAX_AGE_SECONDS = 360;
export const DEPOSIT_CONFIRMATIONS = 10;

export type ArgType = 'u64' | 'string' | 'bool';
export interface AccountSpec { name: string; writable: boolean; signer: boolean }
export interface InstructionSpec { name: string; args: { name: string; type: ArgType }[]; accounts: AccountSpec[] }
export interface FieldSpec { name: string; type: 'pubkey' | 'u64' | 'i64' | 'u16' | 'u8' | 'bool' | 'string' | 'bytes32' | 'bytes' | 'enum' }

const acc = (name: string, flags = ''): AccountSpec => ({ name, writable: flags.includes('w'), signer: flags.includes('s') });

/** The assumed interface. Every row is checked against the vendor IDL when it is present. */
export const LAYOUT = {
  instructions: {
    request_withdrawal: {
      name: 'request_withdrawal',
      args: [{ name: 'nonce', type: 'u64' }, { name: 'amount', type: 'u64' }, { name: 'xmr_address', type: 'string' }, { name: 'exact_out', type: 'bool' }],
      accounts: [acc('config'), acc('withdrawal', 'w'), acc('wxmr_mint', 'w'), acc('user_token_account', 'w'), acc('fee_treasury', 'w'), acc('fee_override'),
        acc('user', 'ws'), acc('token_program'), acc('system_program'), acc('withdrawal_state', 'w')],
    },
    cancel_withdrawal: {
      name: 'cancel_withdrawal',
      args: [],
      accounts: [acc('config'), acc('withdrawal', 'w'), acc('wxmr_mint', 'w'), acc('user_token_account', 'w'), acc('user', 'ws'), acc('authority', 'w'),
        acc('withdrawal_state', 'w'), acc('token_program'), acc('associated_token_program'), acc('system_program')],
    },
    create_deposit_account: {
      name: 'create_deposit_account',
      args: [],
      accounts: [acc('config'), acc('deposit', 'w'), acc('user', 'ws'), acc('system_program')],
    },
  } satisfies Record<string, InstructionSpec>,
  accounts: {
    BridgeConfig: [{ name: 'authority', type: 'pubkey' }, { name: 'wxmr_mint', type: 'pubkey' }, { name: 'total_deposits', type: 'u64' }, { name: 'total_withdrawals', type: 'u64' }, { name: 'bump', type: 'u8' }, { name: 'fee_bps', type: 'u16' }],
    FeeOverride: [{ name: 'user', type: 'pubkey' }, { name: 'fee_bps', type: 'u16' }, { name: 'bump', type: 'u8' }],
    DepositRecord: [{ name: 'owner', type: 'pubkey' }, { name: 'xmr_deposit_address', type: 'string' }, { name: 'total_deposited', type: 'u64' }, { name: 'status', type: 'enum' }, { name: 'bump', type: 'u8' }, { name: 'created_at', type: 'i64' }],
    WithdrawalRecord: [{ name: 'user', type: 'pubkey' }, { name: 'nonce', type: 'u64' }, { name: 'amount', type: 'u64' }, { name: 'xmr_address', type: 'string' }, { name: 'exact_out', type: 'bool' }, { name: 'status', type: 'enum' }, { name: 'bump', type: 'u8' }, { name: 'created_at', type: 'i64' }, { name: 'fee', type: 'u64' }],
    UserWithdrawalState: [{ name: 'user', type: 'pubkey' }, { name: 'last_nonce', type: 'u64' }, { name: 'bump', type: 'u8' }],
    Heartbeat: [{ name: 'generation', type: 'u64' }, { name: 'updated_at', type: 'i64' }, { name: 'page_count', type: 'u16' }, { name: 'digest', type: 'bytes32' }],
    HeartbeatPage: [{ name: 'generation', type: 'u64' }, { name: 'index', type: 'u16' }, { name: 'data', type: 'bytes' }],
    AuditRecord: [{ name: 'epoch', type: 'u64' }, { name: 'timestamp', type: 'i64' }, { name: 'circulating_supply', type: 'u64' }, { name: 'spendable_balance', type: 'u64' }, { name: 'unconfirmed_balance', type: 'u64' }, { name: 'data', type: 'string' }, { name: 'bump', type: 'u8' }],
  } satisfies Record<string, FieldSpec[]>,
  events: {
    WithdrawCompletedEvent: [{ name: 'withdrawal_pda', type: 'pubkey' }, { name: 'user', type: 'pubkey' }, { name: 'amount', type: 'u64' }, { name: 'xmr_address', type: 'string' }, { name: 'xmr_tx_hash', type: 'string' }, { name: 'xmr_tx_key', type: 'string' }],
    WithdrawRevertedEvent: [{ name: 'withdrawal_pda', type: 'pubkey' }, { name: 'user', type: 'pubkey' }, { name: 'amount', type: 'u64' }, { name: 'fee', type: 'u64' }, { name: 'reason', type: 'string' }],
  } satisfies Record<string, FieldSpec[]>,
  enums: {
    DepositStatus: ['Pending', 'Active', 'Closed'],
    WithdrawalStatus: ['Pending', 'Sending', 'Completed'],
  },
} as const;

// ---------------------------------------------------------------- discriminators

const sha8 = (s: string): Buffer => createHash('sha256').update(s).digest().subarray(0, 8);
/** Anchor: `sha256("global:<name>")[..8]`. */
export const instructionDiscriminator = (name: string): Buffer => sha8(`global:${name}`);
/** Anchor: `sha256("account:<Name>")[..8]`. */
export const accountDiscriminator = (name: string): Buffer => sha8(`account:${name}`);
/** Anchor: `sha256("event:<Name>")[..8]`. */
export const eventDiscriminator = (name: string): Buffer => sha8(`event:${name}`);

// ---------------------------------------------------------------- PDAs

const u64le = (n: bigint): Buffer => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const u16le = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const pda = (seeds: (Buffer | Uint8Array)[], program: PublicKey): PublicKey => PublicKey.findProgramAddressSync(seeds, program)[0];

export const bridgePdas = (program: PublicKey = BRIDGE_PROGRAM_ID) => ({
  config: () => pda([Buffer.from('config')], program),
  feeTreasury: () => pda([Buffer.from('fee_treasury')], program),
  feeOverride: (user: PublicKey) => pda([Buffer.from('fee_override'), user.toBuffer()], program),
  deposit: (user: PublicKey) => pda([Buffer.from('deposit'), user.toBuffer()], program),
  withdrawal: (user: PublicKey, nonce: bigint) => pda([Buffer.from('withdrawal'), user.toBuffer(), u64le(nonce)], program),
  withdrawalState: (user: PublicKey) => pda([Buffer.from('withdrawal_state'), user.toBuffer()], program),
  heartbeat: () => pda([Buffer.from('heartbeat')], program),
  heartbeatPage: (generation: bigint, index: number) => pda([Buffer.from('heartbeat-page'), Buffer.from([Number(generation % 2n)]), u16le(index)], program),
  audit: (id: bigint) => pda([Buffer.from('audit'), u64le(id)], program),
  /** The upgradeable loader's ProgramData account, which names the upgrade authority. */
  programData: () => pda([program.toBuffer()], BPF_UPGRADEABLE_LOADER_ID),
});

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return pda([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ASSOCIATED_TOKEN_PROGRAM_ID);
}

// ---------------------------------------------------------------- instruction encoders

function encodeArgs(spec: InstructionSpec, values: Record<string, bigint | string | boolean>): Buffer {
  const parts: Buffer[] = [instructionDiscriminator(spec.name)];
  for (const a of spec.args) {
    const v = values[a.name];
    if (a.type === 'u64') {
      if (typeof v !== 'bigint' || v < 0n || v > 0xffff_ffff_ffff_ffffn) throw new Error(`${spec.name}.${a.name}: not a u64`);
      parts.push(u64le(v));
    } else if (a.type === 'string') {
      if (typeof v !== 'string') throw new Error(`${spec.name}.${a.name}: not a string`);
      const bytes = Buffer.from(v, 'utf8');
      const len = Buffer.alloc(4); len.writeUInt32LE(bytes.length);
      parts.push(len, bytes);
    } else {
      if (typeof v !== 'boolean') throw new Error(`${spec.name}.${a.name}: not a bool`);
      parts.push(Buffer.from([v ? 1 : 0]));
    }
  }
  return Buffer.concat(parts);
}

function build(spec: InstructionSpec, keys: Record<string, PublicKey>, args: Record<string, bigint | string | boolean>, program: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: program,
    keys: spec.accounts.map((a) => {
      const pubkey = keys[a.name];
      if (!pubkey) throw new Error(`${spec.name}: missing account ${a.name}`);
      return { pubkey, isSigner: a.signer, isWritable: a.writable };
    }),
    data: encodeArgs(spec, args),
  });
}

export interface RequestWithdrawalArgs {
  user: PublicKey;
  /** The user's wXMR token account. Defaults to the associated token account. */
  userTokenAccount?: PublicKey;
  /** Must exceed the user's stored watermark. Persist it before sending. */
  nonce: bigint;
  amount: bigint;
  xmrAddress: string;
  /** false: `amount` is the total debit and the fee comes out of it. true: `amount` is the net XMR and the fee is added on top. */
  exactOut: boolean;
}

export function requestWithdrawalIx(a: RequestWithdrawalArgs, program: PublicKey = BRIDGE_PROGRAM_ID, mint: PublicKey = WXMR_MINT): TransactionInstruction {
  if (a.amount < BRIDGE_MIN_ATOMIC) throw new Error('request_withdrawal: amount is below the 0.1 XMR minimum');
  if (a.xmrAddress.length !== 95 && a.xmrAddress.length !== 106) throw new Error('request_withdrawal: not a Monero address (95 or 106 characters)');
  const p = bridgePdas(program);
  return build(LAYOUT.instructions.request_withdrawal, {
    config: p.config(), withdrawal: p.withdrawal(a.user, a.nonce), wxmr_mint: mint,
    user_token_account: a.userTokenAccount ?? associatedTokenAddress(a.user, mint), fee_treasury: p.feeTreasury(), fee_override: p.feeOverride(a.user),
    user: a.user, token_program: TOKEN_PROGRAM_ID, system_program: SystemProgram.programId, withdrawal_state: p.withdrawalState(a.user),
  }, { nonce: a.nonce, amount: a.amount, xmr_address: a.xmrAddress, exact_out: a.exactOut }, program);
}

export interface CancelWithdrawalArgs { user: PublicKey; nonce: bigint; /** `config.authority`, read from chain. */ authority: PublicKey }

export function cancelWithdrawalIx(a: CancelWithdrawalArgs, program: PublicKey = BRIDGE_PROGRAM_ID, mint: PublicKey = WXMR_MINT): TransactionInstruction {
  const p = bridgePdas(program);
  return build(LAYOUT.instructions.cancel_withdrawal, {
    config: p.config(), withdrawal: p.withdrawal(a.user, a.nonce), wxmr_mint: mint, user_token_account: associatedTokenAddress(a.user, mint),
    user: a.user, authority: a.authority, withdrawal_state: p.withdrawalState(a.user),
    token_program: TOKEN_PROGRAM_ID, associated_token_program: ASSOCIATED_TOKEN_PROGRAM_ID, system_program: SystemProgram.programId,
  }, {}, program);
}

export function createDepositAccountIx(user: PublicKey, program: PublicKey = BRIDGE_PROGRAM_ID): TransactionInstruction {
  const p = bridgePdas(program);
  return build(LAYOUT.instructions.create_deposit_account, { config: p.config(), deposit: p.deposit(user), user, system_program: SystemProgram.programId }, {}, program);
}

/** Associated Token Account program, `CreateIdempotent` (instruction 1): creates the owner's token account if it does not exist. */
export function createAtaIdempotentIx(payer: PublicKey, owner: PublicKey, mint: PublicKey): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedTokenAddress(owner, mint), isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]),
  });
}

/** The next withdrawal nonce: `max(last + 1, now in ms)` (SPEC 7.7). */
export function nextWithdrawalNonce(lastNonce: bigint, nowSeconds: number): bigint {
  const ms = BigInt(Math.floor(nowSeconds * 1000));
  return lastNonce + 1n > ms ? lastNonce + 1n : ms;
}

/** Fee and net of a fee-inclusive (`exact_out = false`) withdrawal of `amount`. */
export function withdrawalNet(amount: bigint, feeBps: number): { fee: bigint; net: bigint } {
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  return { fee, net: amount - fee };
}

// ---------------------------------------------------------------- decoders

class Reader {
  private o = 0;
  constructor(private readonly b: Buffer) {}
  private take(n: number): Buffer {
    if (this.o + n > this.b.length) throw new Error('account data is shorter than its layout');
    const s = this.b.subarray(this.o, this.o + n); this.o += n; return s;
  }
  get remaining(): number { return this.b.length - this.o; }
  pubkey(): string { return new PublicKey(this.take(32)).toBase58(); }
  u64(): bigint { return this.take(8).readBigUInt64LE(); }
  i64(): bigint { return this.take(8).readBigInt64LE(); }
  u16(): number { return this.take(2).readUInt16LE(); }
  u8(): number { return this.take(1).readUInt8(); }
  bytes(n: number): Buffer { return Buffer.from(this.take(n)); }
  vec(): Buffer { return this.bytes(this.take(4).readUInt32LE()); }
  string(): string { return this.vec().toString('utf8'); }
}

function decode(fields: readonly FieldSpec[], r: Reader): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    switch (f.type) {
      case 'pubkey': out[f.name] = r.pubkey(); break;
      case 'u64': out[f.name] = r.u64(); break;
      case 'i64': out[f.name] = r.i64(); break;
      case 'u16': out[f.name] = r.u16(); break;
      case 'u8': case 'enum': out[f.name] = r.u8(); break;
      case 'bool': out[f.name] = r.u8() !== 0; break;
      case 'string': out[f.name] = r.string(); break;
      case 'bytes32': out[f.name] = r.bytes(32); break;
      case 'bytes': out[f.name] = r.vec(); break;
    }
  }
  return out;
}

export interface RawAccount { owner: string; data: Uint8Array }

function body(name: keyof typeof LAYOUT.accounts, account: RawAccount, program: PublicKey): Reader {
  if (account.owner !== program.toBase58()) throw new Error(`${name}: account is not owned by the bridge program`);
  const data = Buffer.from(account.data);
  if (data.length < 8 || !data.subarray(0, 8).equals(accountDiscriminator(name))) throw new Error(`${name}: wrong account discriminator`);
  return new Reader(data.subarray(8));
}

export interface BridgeConfig { authority: string; wxmrMint: string; totalDeposits: bigint; totalWithdrawals: bigint; feeBps: number }
export function decodeBridgeConfig(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): BridgeConfig {
  const r = body('BridgeConfig', a, program);
  // `fee_bps` is last so that a config created before the field existed (two bytes shorter) still reads, with no fee.
  const f = decode(LAYOUT.accounts.BridgeConfig.slice(0, 5), r);
  return { authority: f['authority'] as string, wxmrMint: f['wxmr_mint'] as string, totalDeposits: f['total_deposits'] as bigint, totalWithdrawals: f['total_withdrawals'] as bigint, feeBps: r.remaining >= 2 ? r.u16() : 0 };
}

export function decodeFeeOverride(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): { user: string; feeBps: number } {
  const f = decode(LAYOUT.accounts.FeeOverride, body('FeeOverride', a, program));
  return { user: f['user'] as string, feeBps: f['fee_bps'] as number };
}

export interface DepositRecord { owner: string; xmrDepositAddress: string; totalDeposited: bigint; status: 'Pending' | 'Active' | 'Closed'; createdAt: number }
export function decodeDepositRecord(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): DepositRecord {
  const f = decode(LAYOUT.accounts.DepositRecord, body('DepositRecord', a, program));
  const status = LAYOUT.enums.DepositStatus[f['status'] as number];
  if (!status) throw new Error('DepositRecord: unknown status');
  return { owner: f['owner'] as string, xmrDepositAddress: f['xmr_deposit_address'] as string, totalDeposited: f['total_deposited'] as bigint, status, createdAt: Number(f['created_at']) };
}

export interface WithdrawalRecord { user: string; nonce: bigint; amount: bigint; xmrAddress: string; exactOut: boolean; status: 'Pending' | 'Sending' | 'Completed'; createdAt: number; fee: bigint }
export function decodeWithdrawalRecord(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): WithdrawalRecord {
  const f = decode(LAYOUT.accounts.WithdrawalRecord, body('WithdrawalRecord', a, program));
  const status = LAYOUT.enums.WithdrawalStatus[f['status'] as number];
  if (!status) throw new Error('WithdrawalRecord: unknown status');
  return { user: f['user'] as string, nonce: f['nonce'] as bigint, amount: f['amount'] as bigint, xmrAddress: f['xmr_address'] as string, exactOut: f['exact_out'] as boolean, status, createdAt: Number(f['created_at']), fee: f['fee'] as bigint };
}

export function decodeWithdrawalState(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): { user: string; lastNonce: bigint } {
  const f = decode(LAYOUT.accounts.UserWithdrawalState, body('UserWithdrawalState', a, program));
  return { user: f['user'] as string, lastNonce: f['last_nonce'] as bigint };
}

export interface HeartbeatRoot { generation: bigint; updatedAt: number; pageCount: number; digest: Buffer }
export function decodeHeartbeatRoot(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): HeartbeatRoot {
  if (a.data.length !== 58) throw new Error('Heartbeat: root account is not 58 bytes');
  const f = decode(LAYOUT.accounts.Heartbeat, body('Heartbeat', a, program));
  return { generation: f['generation'] as bigint, updatedAt: Number(f['updated_at']), pageCount: f['page_count'] as number, digest: f['digest'] as Buffer };
}

export function decodeHeartbeatPage(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): { generation: bigint; index: number; data: Buffer } {
  const f = decode(LAYOUT.accounts.HeartbeatPage, body('HeartbeatPage', a, program));
  return { generation: f['generation'] as bigint, index: f['index'] as number, data: f['data'] as Buffer };
}

export interface AuditRecord { epoch: bigint; timestamp: number; circulatingSupply: bigint; spendableBalance: bigint; unconfirmedBalance: bigint; data: string }
export function decodeAuditRecord(a: RawAccount, program: PublicKey = BRIDGE_PROGRAM_ID): AuditRecord {
  const f = decode(LAYOUT.accounts.AuditRecord.slice(0, 6), body('AuditRecord', a, program));
  return { epoch: f['epoch'] as bigint, timestamp: Number(f['timestamp']), circulatingSupply: f['circulating_supply'] as bigint, spendableBalance: f['spendable_balance'] as bigint, unconfirmedBalance: f['unconfirmed_balance'] as bigint, data: f['data'] as string };
}

/** SPL Token account: mint (32), owner (32), amount (u64 LE at offset 64). */
export function decodeTokenAmount(a: RawAccount): { mint: string; owner: string; amount: bigint } {
  if (a.owner !== TOKEN_PROGRAM_ID.toBase58() || a.data.length < 72) throw new Error('not an SPL token account');
  const d = Buffer.from(a.data);
  return { mint: new PublicKey(d.subarray(0, 32)).toBase58(), owner: new PublicKey(d.subarray(32, 64)).toBase58(), amount: d.readBigUInt64LE(64) };
}

/**
 * The upgrade authority, from the loader's ProgramData account: u32 tag 3, u64 slot, then
 * `Option<Pubkey>`. `null` means the program can no longer be upgraded.
 */
export function decodeUpgradeAuthority(a: RawAccount): string | null {
  const d = Buffer.from(a.data);
  if (a.owner !== BPF_UPGRADEABLE_LOADER_ID.toBase58() || d.length < 13 || d.readUInt32LE(0) !== 3) throw new Error('not a ProgramData account');
  if (d[12] === 0) return null;
  if (d.length < 45) throw new Error('ProgramData account is truncated');
  return new PublicKey(d.subarray(13, 45)).toBase58();
}

// ---------------------------------------------------------------- events

export interface WithdrawCompleted { kind: 'completed'; withdrawalPda: string; user: string; amount: bigint; xmrAddress: string; xmrTxHash: string; xmrTxKey: string }
export interface WithdrawReverted { kind: 'reverted'; withdrawalPda: string; user: string; amount: bigint; fee: bigint; reason: string }

/** Decodes the bridge events this adapter needs from a transaction's log lines (`Program data: <base64>`). */
export function parseBridgeEvents(logs: readonly string[]): (WithdrawCompleted | WithdrawReverted)[] {
  const out: (WithdrawCompleted | WithdrawReverted)[] = [];
  const completed = eventDiscriminator('WithdrawCompletedEvent'), reverted = eventDiscriminator('WithdrawRevertedEvent');
  for (const line of logs) {
    const m = /^Program data: ([A-Za-z0-9+/=]+)$/.exec(line);
    if (!m) continue;
    const bytes = Buffer.from(m[1]!, 'base64');
    if (bytes.length < 8) continue;
    try {
      const r = new Reader(bytes.subarray(8));
      if (bytes.subarray(0, 8).equals(completed)) {
        const f = decode(LAYOUT.events.WithdrawCompletedEvent, r);
        out.push({ kind: 'completed', withdrawalPda: f['withdrawal_pda'] as string, user: f['user'] as string, amount: f['amount'] as bigint, xmrAddress: f['xmr_address'] as string, xmrTxHash: f['xmr_tx_hash'] as string, xmrTxKey: f['xmr_tx_key'] as string });
      } else if (bytes.subarray(0, 8).equals(reverted)) {
        const f = decode(LAYOUT.events.WithdrawRevertedEvent, r);
        out.push({ kind: 'reverted', withdrawalPda: f['withdrawal_pda'] as string, user: f['user'] as string, amount: f['amount'] as bigint, fee: f['fee'] as bigint, reason: f['reason'] as string });
      }
    } catch { /* a log line that only looks like an event */ }
  }
  return out;
}
