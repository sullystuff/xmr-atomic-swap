// A Solana world for the integration tests: the built program inside tools/svm-rpc (an in-memory
// LiteSVM behind JSON-RPC on loopback; not a validator, not a cluster), initialised, with one
// registered maker, a taker and a stranger. svm-rpc has no WebSocket, so everything polls.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Connection, type TransactionInstruction } from '@solana/web3.js';
import { type DerivedKeys } from '@xmrswap/core-wasm';
import { DEV_PROGRAM_ID, type Maker, type OfferTerms, base58Decode } from '@xmrswap/protocol';
import { type SvmRpc, startSvmRpc } from '@xmrswap/svm-rpc';
import { type CallMaterial, solanaInstruction } from '../../src/flows/execute.js';
import { makerShareKeys, solanaMakerShare } from '../../src/flows/keys.js';
import type { Decision } from '../../src/flows/types.js';
import type { SwapView } from '../../src/machine/view.js';
import { SolanaClient, type SolanaSigner, seedSigner } from '../../src/solana/client.js';
import { ata } from '../../src/solana/pdas.js';
import { type SolanaTransport, connectionTransport } from '../../src/solana/transport.js';
import { type Bytes, hex } from '../../src/util.js';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const SO = process.env.XMR_SWAP_SO ?? path.join(repoRoot, 'solana/program/target/deploy/xmr_swap.so');
export const T0 = 1_800_000_000;
export const XMR = 1_000_000_000_000n;
const seed = (n: number) => new Uint8Array(32).fill(n);
/** The operator's Ed25519 seed (the daemon's hot key): signs advance approvals and envelopes. */
export const OPERATOR_SEED = seed(3);

export interface SolWorld {
  svm: SvmRpc;
  transport: SolanaTransport;
  client: SolanaClient;
  usdc: string;
  genesis: string;
  admin: SolanaSigner;
  owner: SolanaSigner;
  operator: SolanaSigner;
  payout: SolanaSigner;
  taker: SolanaSigner;
  stranger: SolanaSigner;
  /** Maker PDA, base58. */
  makerPda: string;
  /** The maker's keystore seed and its current X25519 key pair. */
  makerSeed: Bytes;
  makerEnc: DerivedKeys;
  /** Shares the maker published, by hex of the spend commitment (its "database"). */
  shares: Map<string, DerivedKeys>;
  rent0: bigint;
  now(): Promise<bigint>;
  /** Move chain time forward to `t` (never backwards). */
  warpTo(t: bigint): Promise<void>;
  send(ixs: TransactionInstruction[], signers: SolanaSigner[]): Promise<string>;
  maker(): Promise<Maker>;
  swap(pda: string): Promise<SwapView | null>;
  /** A fresh maker share, recorded before it is published. */
  newShare(): DerivedKeys;
  /** `set_offer`, pool keys for direction A, then one `refresh_offers` that makes it live. */
  publishOffer(o: { asset: number; direction: number; mode: number; price: bigint; depBps?: number; capacityXmr?: bigint; terms?: Partial<OfferTerms> }): Promise<void>;
  /** Carry out a flow decision of kind `call` with the signer its caller names. */
  exec(s: SwapView, d: Decision, signers: { session?: SolanaSigner }, m?: CallMaterial): Promise<string>;
  balance(pubkey: string): Promise<bigint>;
  tokenBalance(owner: string): Promise<bigint>;
  stop(): Promise<void>;
}

export async function startSolana(): Promise<SolWorld> {
  if (!existsSync(SO)) throw new Error(`integration: ${SO} is missing; build it with \`cd solana/program && cargo build-sbf\``);
  const svm = await startSvmRpc({ programs: [{ programId: DEV_PROGRAM_ID, soPath: SO }], unixTimestamp: T0 });
  const transport = connectionTransport(new Connection(svm.url, 'confirmed'), { subscriptions: false });
  const [admin, owner, operator, payout, taker, stranger] = [1, 2, 3, 4, 5, 6].map((n) => seedSigner(seed(n))) as [SolanaSigner, SolanaSigner, SolanaSigner, SolanaSigner, SolanaSigner, SolanaSigner];
  for (const s of [admin, owner, operator, payout, taker, stranger]) await svm.airdrop(s.publicKey, 100_000_000_000n);
  await svm.setUpgradeAuthority(DEV_PROGRAM_ID, admin.publicKey);
  const usdc = await svm.createMint(6, admin.publicKey);
  // Payouts never create token accounts: every party that may receive USDC has its account.
  for (const s of [operator, payout, taker]) await svm.mintTo(usdc, s.publicKey, 1_000_000_000_000n);
  const client = new SolanaClient({ transport, programId: DEV_PROGRAM_ID, usdcMint: usdc, subscriptions: false });
  const genesis = await transport.getGenesisHash();
  const makerSeed = seed(77);
  const makerEnc = makerShareKeys(makerSeed, 'solana', new Uint8Array(16).fill(1));
  const shares = new Map<string, DerivedKeys>();
  let shareCounter = 1;

  const send = (ixs: TransactionInstruction[], signers: SolanaSigner[]) => client.sendAndConfirm(ixs, signers, { intervalMs: 20 });
  await send([client.program.initialize({ authority: admin.publicKey, usdcMint: usdc, clusterTag: base58Decode(genesis), treasuryAuthority: admin.publicKey, splitMode: 0 })], [admin]);
  await send([client.program.registerMaker({ owner: owner.publicKey, operator: operator.publicKey, payout: payout.publicKey, encKey: makerEnc.encPub })], [owner]);
  const makerPda = client.program.makerPda(owner.publicKey).toBase58();
  const rent0 = await transport.getMinimumBalanceForRentExemption(0);

  const w: SolWorld = {
    svm, transport, client, usdc, genesis, admin, owner, operator, payout, taker, stranger, makerPda, makerSeed, makerEnc, shares, rent0,
    now: () => client.chainTime(),
    async warpTo(t) {
      const now = await client.chainTime();
      if (t > now) await svm.warp(t - now);
    },
    send,
    async maker() {
      return (await client.getMaker(makerPda))!;
    },
    swap: (pda) => client.getSwap(pda),
    newShare() {
      const id = new Uint8Array(16);
      new DataView(id.buffer).setUint32(0, ++shareCounter);
      const k = makerShareKeys(makerSeed, 'solana', id);
      shares.set(hex(k.spendPub), k);
      return k;
    },
    async publishOffer(o) {
      const terms: OfferTerms = { mode: o.mode, minXmr: XMR / 100n, maxXmr: 1000n * XMR, validSecs: 3600, priceAbove: [0n, 0n, 0n], depthAbove: [0n, 0n, 0n], depths: Uint8Array.of(2, 0, 0), depBps: o.depBps ?? 100, wA: 60, wN: 600, dC: 3600, wC: 1800, wF: 604_800, ...o.terms };
      await send([client.program.setOffer(operator.publicKey, makerPda, o.asset, o.direction, terms)], [operator]);
      if (o.direction === 0) {
        const pda = base58Decode(makerPda);
        const offer = await client.getOffer(makerPda, o.asset, 0);
        const slots = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !(((offer!.poolFilled & ~offer!.poolUsed) >> i) & 1)).map((index) => ({ index, ...solanaMakerShare(w.newShare(), pda) }));
        if (slots.length) await send([client.program.refillKeys(operator.publicKey, makerPda, o.asset, slots)], [operator]);
      }
      await send([client.program.refreshOffers(operator.publicKey, makerPda, [{ asset: o.asset, direction: o.direction, enabled: true, prices: [o.price, 0n, 0n], capacityXmr: o.capacityXmr ?? 1000n * XMR }])], [operator]);
    },
    async exec(s, d, signers, m = {}) {
      if (d.do !== 'call') throw new Error(`not a call: ${JSON.stringify(d, (_k, v) => (typeof v === 'bigint' ? v.toString() : v))}`);
      const mk = await w.maker();
      const signer = d.caller === 'operator' ? operator : d.caller === 'taker' ? taker : d.caller === 'owner' ? owner : d.caller === 'anyone' ? stranger : signers.session;
      if (!signer) throw new Error('the session key is needed for this call');
      return send([solanaInstruction(client.program, s, { operator: mk.operator, payout: mk.payout }, signer.publicKey, d.call, m)], [signer]);
    },
    async balance(pubkey) {
      return (await transport.getAccount(pubkey))?.lamports ?? 0n;
    },
    async tokenBalance(ownerKey) {
      const a = await transport.getAccount(ata(ownerKey, usdc).toBase58());
      return a ? new DataView(a.data.buffer, a.data.byteOffset).getBigUint64(64, true) : 0n;
    },
    stop: () => svm.stop(),
  };
  return w;
}
