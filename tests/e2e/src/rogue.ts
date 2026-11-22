// A dishonest maker, played with the SDK: it registers and publishes a Solana offer like any
// maker, then announces XMR locks that are false in a chosen way, or never announces at all.
// The real daemon never does these things, so the scenarios that prove the taker's defences
// (the tab refunds by itself at the cutoff) need this stand-in. Its XMR comes from a wallet the
// harness funds on the regtest.
import { type DerivedKeys } from '@xmrswap/core-wasm';
import { type OfferTerms, SWAP_STATE, base58Decode } from '@xmrswap/protocol';
import { type SolanaSigner, type SwapView, buildNotice, hex, makerShareKeys, seedSigner, solanaInstruction, solanaMakerShare, swapJointAddress } from '@xmrswap/sdk';
import { NODE_A, type Wallet, nodeOther } from './monero.js';
import { XMR, fill } from './util.js';
import type { World } from './world.js';

export type Lie =
  /** Pays less than the swap needs to the right address. */
  | 'wrong-amount'
  /** Pays the full amount to an address that is not the swap's joint address. */
  | 'wrong-address'
  /** Announces a transaction it built and then never broadcasts. */
  | 'never-broadcast'
  /** An honest lock (for a maker that later stalls or disappears). */
  | 'honest';

export class RogueMaker {
  readonly owner: SolanaSigner;
  readonly operator: SolanaSigner;
  readonly payout: SolanaSigner;
  readonly seed: Uint8Array;
  readonly enc: DerivedKeys;
  readonly shares = new Map<string, DerivedKeys>();
  pda = '';
  private counter = 1;

  constructor(
    readonly w: World,
    readonly n: number,
    /** The wallet its XMR payments come from. */
    readonly wallet: Wallet,
  ) {
    const k = 200 + n * 5;
    this.owner = seedSigner(fill(k));
    this.operator = seedSigner(fill(k + 1));
    this.payout = seedSigner(fill(k + 2));
    this.seed = fill(k + 3);
    this.enc = makerShareKeys(this.seed, 'solana', new Uint8Array(16).fill(1));
  }
  private newShare(): DerivedKeys {
    const id = new Uint8Array(16);
    new DataView(id.buffer).setUint32(0, ++this.counter);
    const k = makerShareKeys(this.seed, 'solana', id);
    this.shares.set(hex(k.spendPub), k);
    return k;
  }

  /** Register and publish a direction-A SOL offer (auto mode, 1% deposit, depth 2) at `price` lamports per XMR. */
  async publish(price: bigint, terms: Partial<OfferTerms> = {}): Promise<void> {
    const { sol } = this.w;
    const c = sol.client;
    for (const s of [this.owner, this.operator, this.payout]) await sol.fund(s.publicKey);
    await sol.send([c.program.registerMaker({ owner: this.owner.publicKey, operator: this.operator.publicKey, payout: this.payout.publicKey, encKey: this.enc.encPub })], [this.owner]);
    this.pda = c.program.makerPda(this.owner.publicKey).toBase58();
    const t: OfferTerms = { mode: 0, minXmr: XMR / 100n, maxXmr: 5n * XMR, validSecs: 3600, priceAbove: [0n, 0n, 0n], depthAbove: [0n, 0n, 0n], depths: Uint8Array.of(2, 0, 0), depBps: 100, wA: 60, wN: 600, dC: 5400, wC: 1800, wF: 604_800, ...terms };
    await sol.send([c.program.setOffer(this.operator.publicKey, this.pda, 0, 0, t)], [this.operator]);
    await this.refresh(price);
  }
  /** What a running daemon does every few seconds: top up the key pool and refresh the offer. */
  async refresh(price: bigint): Promise<void> {
    const { sol } = this.w;
    const c = sol.client;
    const offer = (await c.getOffer(this.pda, 0, 0))!;
    const slots = [0, 1, 2, 3, 4, 5, 6, 7].filter((i) => !(((offer.poolFilled & ~offer.poolUsed) >> i) & 1)).map((index) => ({ index, ...solanaMakerShare(this.newShare(), base58Decode(this.pda)) }));
    if (slots.length) await sol.send([c.program.refillKeys(this.operator.publicKey, this.pda, 0, slots)], [this.operator]);
    await sol.send([c.program.refreshOffers(this.operator.publicKey, this.pda, [{ asset: 0, direction: 0, enabled: true, prices: [price, 0n, 0n], capacityXmr: 1000n * XMR }])], [this.operator]);
  }
  swaps(): Promise<SwapView[]> {
    return this.w.sol.client.listSwapsByMaker(this.pda);
  }

  /** Announce a lock for an ACTIVE swap, lying as told. Returns the transaction id the notice names. */
  async announce(s: SwapView, lie: Lie): Promise<{ txid: string; relayed: boolean }> {
    if (s.state !== SWAP_STATE.ACTIVE) throw new Error('the swap is not ACTIVE');
    const { sol } = this.w;
    const share = this.shares.get(hex(s.makerSpendPub));
    if (!share) throw new Error('the swap names a share this maker does not hold');
    const joint = swapJointAddress(s, share.view, 'regtest');
    const address = lie === 'wrong-address' ? (await this.wallet.address()) : joint.address;
    const amount = lie === 'wrong-amount' ? s.xmr - XMR / 10n : s.xmr;
    await this.wallet.refresh();
    const built = await this.wallet.call<{ tx_hash: string; tx_blob: string }>('transfer', { destinations: [{ address, amount: Number(amount) }], account_index: 0, priority: 0, ring_size: 16, unlock_time: 0, do_not_relay: true, get_tx_hex: true });
    const mk = (await sol.client.getMaker(this.pda))!;
    const notice = buildNotice(s, this.enc.encSecret, Uint8Array.from(Buffer.from(built.tx_hash, 'hex')), share.view);
    await sol.send([solanaInstruction(sol.client.program, s, { operator: mk.operator, payout: mk.payout }, this.operator.publicKey, { name: 'post_notice' }, { notice })], [this.operator]);
    if (lie === 'never-broadcast') return { txid: built.tx_hash, relayed: false };
    const r = await nodeOther<{ status: string; reason?: string }>(NODE_A, 'send_raw_transaction', { tx_as_hex: built.tx_blob, do_not_relay: false });
    if (r.status !== 'OK') throw new Error(`send_raw_transaction: ${r.reason || r.status}`);
    return { txid: built.tx_hash, relayed: true };
  }
  /** Try to take the taker's payment (it must fail whenever the taker has refunded). */
  async claim(s: SwapView): Promise<string> {
    const { sol } = this.w;
    const share = this.shares.get(hex(s.makerSpendPub))!;
    const mk = (await sol.client.getMaker(this.pda))!;
    return sol.send([solanaInstruction(sol.client.program, s, { operator: mk.operator, payout: mk.payout }, this.operator.publicKey, { name: 'claim' }, { secret: share.spend })], [this.operator]);
  }
}
