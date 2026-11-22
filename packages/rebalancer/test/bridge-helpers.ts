/**
 * An in-memory stand-in for the bridge program's accounts, for the bridge tests. Account bytes
 * are written out by hand here (not through the package's layout table) so the decoders are
 * tested against an independent encoding. Nothing here is captured from chain.
 */
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import {
  BPF_UPGRADEABLE_LOADER_ID, BRIDGE_PROGRAM_ID, TOKEN_PROGRAM_ID, USDC_MINT, WSOL_MINT, WXMR_MINT, associatedTokenAddress, bridgePdas,
  type HttpClient, type HttpRequest, type RpcAccount, type RpcTransaction, type SolSend, type SolanaRpc,
} from '../src/index.js';
import { SOL_ADDR } from './helpers.js';

export const WALLET = new PublicKey(SOL_ADDR);
export const AUTHORITY = new PublicKey('Ds4prSZNwyxTz4PZmHXoHDXFzLZ1c8MkfhUwGtqvAvpK');
export const UPGRADE_AUTHORITY = new PublicKey('4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T');
const P = bridgePdas();
const PROGRAM = BRIDGE_PROGRAM_ID.toBase58();

const disc = (kind: 'account' | 'event' | 'global', name: string) => createHash('sha256').update(`${kind}:${name}`).digest().subarray(0, 8);
const u64 = (n: bigint) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(n); return b; };
const i64 = (n: number) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(n)); return b; };
const u16 = (n: number) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n: number) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)]);
const owned = (data: Buffer, owner = PROGRAM): RpcAccount => ({ owner, data: new Uint8Array(data), lamports: 1_000_000n });

export const enc = {
  config: (o: { authority?: PublicKey; feeBps?: number | null; mint?: PublicKey } = {}) =>
    owned(Buffer.concat([disc('account', 'BridgeConfig'), (o.authority ?? AUTHORITY).toBuffer(), (o.mint ?? WXMR_MINT).toBuffer(), u64(123n), u64(45n), Buffer.from([254]), ...(o.feeBps === null ? [] : [u16(o.feeBps ?? 10)])])),
  feeOverride: (user: PublicKey, feeBps: number) => owned(Buffer.concat([disc('account', 'FeeOverride'), user.toBuffer(), u16(feeBps), Buffer.from([253])])),
  deposit: (o: { owner: PublicKey; address: string; total: bigint; status: 0 | 1 | 2 }) =>
    owned(Buffer.concat([disc('account', 'DepositRecord'), o.owner.toBuffer(), str(o.address), u64(o.total), Buffer.from([o.status, 252]), i64(1_790_000_000)])),
  withdrawal: (o: { user: PublicKey; nonce: bigint; amount: bigint; address: string; status: 0 | 1 | 2; createdAt: number; fee: bigint }) =>
    owned(Buffer.concat([disc('account', 'WithdrawalRecord'), o.user.toBuffer(), u64(o.nonce), u64(o.amount), str(o.address), Buffer.from([0, o.status, 251]), i64(o.createdAt), u64(o.fee)])),
  withdrawalState: (user: PublicKey, last: bigint) => owned(Buffer.concat([disc('account', 'UserWithdrawalState'), user.toBuffer(), u64(last), Buffer.from([250])])),
  heartbeatRoot: (o: { generation: bigint; updatedAt: number; pages: number; digest: Buffer }) =>
    owned(Buffer.concat([disc('account', 'Heartbeat'), u64(o.generation), i64(o.updatedAt), u16(o.pages), o.digest])),
  heartbeatPage: (generation: bigint, index: number, data: Buffer) => owned(Buffer.concat([disc('account', 'HeartbeatPage'), u64(generation), u16(index), u32(data.length), data])),
  audit: (id: bigint, data: string) => owned(Buffer.concat([disc('account', 'AuditRecord'), u64(id), i64(1_790_000_000), u64(5n), u64(6n), u64(7n), str(data), Buffer.from([249])])),
  token: (mint: PublicKey, owner: PublicKey, amount: bigint) => owned(Buffer.concat([mint.toBuffer(), owner.toBuffer(), u64(amount), Buffer.alloc(93)]), TOKEN_PROGRAM_ID.toBase58()),
  programData: (authority: PublicKey | null) =>
    owned(Buffer.concat([u32(3), u64(999n), authority ? Buffer.concat([Buffer.from([1]), authority.toBuffer()]) : Buffer.from([0]), Buffer.alloc(64)]), BPF_UPGRADEABLE_LOADER_ID.toBase58()),
  completedEvent: (o: { pda: PublicKey; user: PublicKey; amount: bigint; address: string; txHash: string; txKey: string }) =>
    'Program data: ' + Buffer.concat([disc('event', 'WithdrawCompletedEvent'), o.pda.toBuffer(), o.user.toBuffer(), u64(o.amount), str(o.address), str(o.txHash), str(o.txKey)]).toString('base64'),
  revertedEvent: (o: { pda: PublicKey; user: PublicKey; amount: bigint; fee: bigint; reason: string }) =>
    'Program data: ' + Buffer.concat([disc('event', 'WithdrawRevertedEvent'), o.pda.toBuffer(), o.user.toBuffer(), u64(o.amount), u64(o.fee), str(o.reason)]).toString('base64'),
};

export interface HeartbeatOpts { generation?: bigint; updatedAt: number; observedAt?: number; unlocked?: bigint; balance?: bigint; latestReserve?: { account: string; id: number } | null; padBytes?: number; format?: string }

/** A deterministic, incompressible filler so the payload spans several 700-byte pages. */
function filler(n: number): string {
  let out = '', h = Buffer.from('seed');
  while (out.length < n) { h = createHash('sha256').update(h).digest(); out += h.toString('base64'); }
  return out.slice(0, n);
}

export class FakeChain implements SolanaRpc {
  readonly accounts = new Map<string, RpcAccount>();
  readonly txs = new Map<string, RpcTransaction>();
  readonly sigs = new Map<string, { signature: string; err: unknown }[]>();
  /** wXMR a swap delivers per unit of input, as a function of the piece (set by the test). */
  swapDelivers: (piece: number) => bigint = () => 0n;
  swapFails = false;
  private swaps = 0;
  clock = { t: 1_800_000_000 };
  readonly reads: string[] = [];

  constructor(o: { feeBps?: number; wxmr?: bigint } = {}) {
    this.accounts.set(P.config().toBase58(), enc.config(o.feeBps === undefined ? {} : { feeBps: o.feeBps }));
    this.accounts.set(P.programData().toBase58(), enc.programData(UPGRADE_AUTHORITY));
    this.setWxmr(o.wxmr ?? 0n);
  }

  async getAccount(address: string) { this.reads.push(address); return this.accounts.get(address) ?? null; }
  async getAccounts(addresses: string[]) { return addresses.map((a) => this.accounts.get(a) ?? null); }
  async getSignatures(address: string, limit: number) { return (this.sigs.get(address) ?? []).slice(0, limit); }
  async getTransaction(signature: string) { return this.txs.get(signature) ?? null; }

  wxmr(): bigint { return Buffer.from(this.accounts.get(associatedTokenAddress(WALLET, WXMR_MINT).toBase58())!.data).readBigUInt64LE(64); }
  setWxmr(amount: bigint): void { this.accounts.set(associatedTokenAddress(WALLET, WXMR_MINT).toBase58(), enc.token(WXMR_MINT, WALLET, amount)); }

  setHeartbeat(o: HeartbeatOpts): void {
    const generation = o.generation ?? 7n;
    const balance = o.balance ?? 900_000_000_000_000n;
    const payload: Record<string, unknown> = {
      format: o.format ?? 'wxmr-heartbeat-v1', observedAt: o.observedAt ?? o.updatedAt, moneroHeight: 3_500_000, balanceAtomic: balance.toString(),
      unlockedAtomic: (o.unlocked ?? balance).toString(), targetAtomic: '0', unlocks: [], deposits: [], latestReserve: o.latestReserve ?? null,
    };
    if (o.padBytes) payload['pad'] = filler(o.padBytes);
    const gz = gzipSync(Buffer.from(JSON.stringify(payload)));
    const pages: Buffer[] = [];
    for (let i = 0; i < gz.length; i += 700) pages.push(gz.subarray(i, i + 700));
    this.accounts.set(P.heartbeat().toBase58(), enc.heartbeatRoot({ generation, updatedAt: o.updatedAt, pages: pages.length, digest: createHash('sha256').update(gz).digest() }));
    pages.forEach((p, i) => this.accounts.set(P.heartbeatPage(generation, i).toBase58(), enc.heartbeatPage(generation, i, p)));
  }

  /** What the wallet's `sendSol` does to the chain. Wire it into `fakeCtx(start, chain.onSol)`. */
  onSol = (send: SolSend, sig: string): void => {
    if (send.kind === 'versioned_tx') {
      const piece = this.swaps++;
      if (this.swapFails) { this.txs.set(sig, { err: { InstructionError: [2, 'Custom'] }, logs: [], tokenBalances: [], lamports: [], blockTime: this.clock.t }); return; }
      const got = this.swapDelivers(piece);
      const before = this.wxmr();
      this.setWxmr(before + got);
      this.txs.set(sig, {
        err: null, logs: [], blockTime: this.clock.t,
        tokenBalances: [{ owner: WALLET.toBase58(), mint: WXMR_MINT.toBase58(), pre: before, post: before + got }, { owner: 'SomePoolVaultOwner', mint: WXMR_MINT.toBase58(), pre: 10n ** 15n, post: 10n ** 15n - got }],
        lamports: [{ address: WALLET.toBase58(), pre: 5_000_000_000n, post: 4_999_990_000n }],
      });
      return;
    }
    if (send.kind !== 'instructions') return;
    for (const ix of send.instructions) {
      if (!ix.programId.equals(BRIDGE_PROGRAM_ID)) continue;
      const d = Buffer.from(ix.data);
      if (d.subarray(0, 8).equals(disc('global', 'request_withdrawal'))) {
        const nonce = d.readBigUInt64LE(8), amount = d.readBigUInt64LE(16), len = d.readUInt32LE(24);
        const address = d.subarray(28, 28 + len).toString();
        const stateKey = P.withdrawalState(WALLET).toBase58();
        const st = this.accounts.get(stateKey);
        const last = st ? Buffer.from(st.data).readBigUInt64LE(40) : 0n;
        if (nonce <= last) throw new Error('NonceNotIncreasing');
        if (this.wxmr() < amount) throw new Error('insufficient wXMR');
        const fee = (amount * 10n) / 10_000n;
        this.setWxmr(this.wxmr() - amount);
        this.accounts.set(ix.keys[1]!.pubkey.toBase58(), enc.withdrawal({ user: WALLET, nonce, amount: amount - fee, address, status: 0, createdAt: this.clock.t, fee }));
        this.accounts.set(stateKey, enc.withdrawalState(WALLET, nonce));
      } else if (d.subarray(0, 8).equals(disc('global', 'cancel_withdrawal'))) {
        const key = ix.keys[1]!.pubkey.toBase58();
        const rec = this.accounts.get(key);
        if (!rec) throw new Error('AccountNotInitialized');
        const b = Buffer.from(rec.data);
        this.setWxmr(this.wxmr() + b.readBigUInt64LE(48));
        this.accounts.delete(key);
      } else if (d.subarray(0, 8).equals(disc('global', 'create_deposit_account'))) {
        this.accounts.set(ix.keys[1]!.pubkey.toBase58(), enc.deposit({ owner: WALLET, address: '', total: 0n, status: 0 }));
      }
    }
  };

  private record(nonce: bigint): { key: string; pda: PublicKey; b: Buffer } {
    const pda = P.withdrawal(WALLET, nonce);
    const acc = this.accounts.get(pda.toBase58());
    if (!acc) throw new Error('no such withdrawal');
    return { key: pda.toBase58(), pda, b: Buffer.from(acc.data) };
  }
  markSending(nonce: bigint): void {
    const { key, b } = this.record(nonce);
    const len = b.readUInt32LE(56);
    b[60 + len + 1] = 1;
    this.accounts.set(key, owned(b));
  }
  /** The relayer pays out and closes the record, emitting the completion event. */
  complete(nonce: bigint, txHash: string): void {
    const { key, pda, b } = this.record(nonce);
    const sig = `complete-${nonce}`;
    this.txs.set(sig, { err: null, blockTime: this.clock.t, tokenBalances: [], lamports: [], logs: ['Program log: Instruction: CompleteWithdrawal', enc.completedEvent({ pda, user: WALLET, amount: b.readBigUInt64LE(48), address: 'x', txHash, txKey: 'k'.repeat(64) })] });
    this.sigs.set(key, [{ signature: sig, err: null }, { signature: 'failed-earlier', err: { some: 'error' } }, ...(this.sigs.get(key) ?? [])]);
    this.accounts.delete(key);
  }
  revert(nonce: bigint, reason: string): void {
    const { key, pda, b } = this.record(nonce);
    const sig = `revert-${nonce}`;
    this.txs.set(sig, { err: null, blockTime: this.clock.t, tokenBalances: [], lamports: [], logs: [enc.revertedEvent({ pda, user: WALLET, amount: b.readBigUInt64LE(48), fee: 1n, reason })] });
    this.sigs.set(key, [{ signature: sig, err: null }]);
    this.setWxmr(this.wxmr() + b.readBigUInt64LE(48));
    this.accounts.delete(key);
  }
  nonces(): bigint[] {
    const out: bigint[] = [];
    for (const [, a] of this.accounts) { const b = Buffer.from(a.data); if (a.owner === PROGRAM && b.subarray(0, 8).equals(disc('account', 'WithdrawalRecord'))) out.push(b.readBigUInt64LE(40)); }
    return out.sort((x, y) => (x < y ? -1 : 1));
  }
}

/** An unsigned v0 transaction paid by `payer`, standing in for what Jupiter returns. */
export function swapTxBase64(payer: PublicKey = WALLET): string {
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: '11111111111111111111111111111111', instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: AUTHORITY, lamports: 1 })] }).compileToV0Message();
  return Buffer.from(new VersionedTransaction(msg).serialize()).toString('base64');
}

/**
 * A stand-in for Jupiter's `swap/v1`: quotes at a fixed pool price with an impact that grows
 * with size. HAND-WRITTEN response shape; nothing is recorded from the live API.
 */
export class FakeJupiter implements HttpClient {
  readonly requests: HttpRequest[] = [];
  /** USDC (or USD of SOL) per XMR in the pool. */
  poolPrice = 401.6;
  /** Price impact as a fraction, per 1000 USD of input. */
  impactPer1000Usd = 0.001;
  swapPayer: PublicKey = WALLET;
  async request(req: HttpRequest) {
    this.requests.push(req);
    const url = new URL(req.url);
    if (req.method === 'GET' && url.pathname.endsWith('/quote')) {
      const p = url.searchParams;
      const amount = BigInt(p.get('amount')!);
      const inMint = p.get('inputMint')!, outMint = p.get('outputMint')!;
      const usdIn = inMint === USDC_MINT.toBase58() ? Number(amount) / 1e6 : inMint === WSOL_MINT.toBase58() ? (Number(amount) / 1e9) * 200 : (Number(amount) / 1e12) * this.poolPrice;
      const impact = (usdIn / 1000) * this.impactPer1000Usd;
      const outUsd = usdIn * (1 - impact);
      const out = outMint === WXMR_MINT.toBase58() ? BigInt(Math.floor((outUsd / this.poolPrice) * 1e12)) : outMint === USDC_MINT.toBase58() ? BigInt(Math.floor(outUsd * 1e6)) : BigInt(Math.floor((outUsd / 200) * 1e9));
      return { status: 200, body: JSON.stringify({ inputMint: inMint, outputMint: outMint, inAmount: amount.toString(), outAmount: out.toString(), otherAmountThreshold: ((out * 995n) / 1000n).toString(), swapMode: 'ExactIn', slippageBps: 50, priceImpactPct: impact.toString(), routePlan: [] }) };
    }
    if (req.method === 'POST' && url.pathname.endsWith('/swap')) return { status: 200, body: JSON.stringify({ swapTransaction: swapTxBase64(this.swapPayer), lastValidBlockHeight: 1 }) };
    return { status: 404, body: '{}' };
  }
  quotes(): number { return this.requests.filter((r) => r.url.includes('/quote')).length; }
  swaps(): number { return this.requests.filter((r) => r.url.endsWith('/swap')).length; }
}

/** A structurally valid `wxmr-reserve-v1` record (the proof string itself is a placeholder; the verifier is faked). */
export function reserveReport(id: number, over: Record<string, unknown> = {}): string {
  const bound = {
    format: 'wxmr-reserve-v1', id, address: '4' + 'A'.repeat(94), monero: { network: 'mainnet', height: 3_499_990, hash: 'ab'.repeat(32) },
    solana: { genesisHash: '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d', program: PROGRAM, mint: WXMR_MINT.toBase58(), slot: 1, blockhash: '11111111111111111111111111111111', supplyAtomic: '800000000000000' },
    scope: 'reserves-with-supply-reference',
  };
  return JSON.stringify({
    ...bound, message: JSON.stringify(bound), proof: 'ReserveProofV2' + 'A'.repeat(40), proofSha256: 'cd'.repeat(32),
    verified: { at: 1, moneroHeight: 3_500_000, totalAtomic: '900000000000000', spentAtomic: '0', unspentAtomic: '900000000000000' },
    walletReported: { balanceAtomic: '900000000000000', unlockedAtomic: '900000000000000', outputs: 9 }, ...over,
  });
}
