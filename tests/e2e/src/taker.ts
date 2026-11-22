// The taker driven through the SDK instead of the browser, for scenarios that need exact
// control of what is sent and when (a taker that goes away, refunds at a chosen second, or
// misbehaves). It does what the page does: derive keys from a seed and a fresh nonce, check the
// maker's proofs, open the swap, and act with the session key. Messages to the maker go
// browser-style: relay -> (fake Tor) -> the daemon's endpoint.
import { type DerivedKeys, type EthApproval, sweepJoint } from '@xmrswap/core-wasm';
import type { Address, Market } from '@xmrswap/protocol';
import {
  type CallMaterial, type FlowCall, MakerHttp, type SignedSolApproval, type SolanaSigner, type SwapView, buildNotice, decodeSignedQuote, ethSessionBudget, ethereumCall, fetchPool, fetchProof, hex, hex0x, jointSpendKey, leafArgument, newSwapNonce, openNotice,
  pickLeaf, planEthereumOpen, planSolanaOpen, relayEndpoint, seedSigner, solanaInstruction, swapJointAddress, takerSwapKeys, uploadOwnProof, verifyFundedShare, verifyLock, type VerifyLockResult,
} from '@xmrswap/sdk';
import { type PrivateKeyAccount, privateKeyToAccount } from 'viem/accounts';
import type { Maker } from './maker.js';
import { NODE_A, NODE_B, REGTEST_MAX_FEE } from './monero.js';
import { waitFor } from './util.js';
import type { World } from './world.js';

export interface Opened {
  chain: 'solana' | 'ethereum';
  market: Market;
  direction: 0 | 1;
  /** Swap PDA (base58) or 0x swap id. */
  ref: string;
  swapId: Uint8Array | null;
  keys: DerivedKeys;
  amount: bigint;
  deposit: bigint;
  maker: Maker;
}

const ASSET: Record<Market, number> = { sol: 0, usdc_sol: 1, eth: 0, usdc_eth: 1 };
const unhex = (s: string): Uint8Array => Uint8Array.from(Buffer.from(s, 'hex'));

export class SdkTaker {
  readonly solSession = new Map<string, SolanaSigner>();
  readonly ethSession = new Map<string, PrivateKeyAccount>();
  constructor(
    readonly w: World,
    readonly seed: Uint8Array = w.takerSeed,
    readonly solKey: SolanaSigner = w.sol.taker,
    readonly ethKey: PrivateKeyAccount | null = w.eth?.taker ?? null,
  ) {}

  /** The maker's `/xs/v1` endpoint as a browser reaches it: through the relay and the fake Tor. */
  http(m: Maker = this.w.maker): MakerHttp {
    return new MakerHttp(relayEndpoint(this.w.relay.url, m.o.onion));
  }

  /** The maker's live Solana offer for a market and direction, once the daemon has published it. */
  async offer(m: Maker, market: Market, direction: 0 | 1) {
    return waitFor(`a live ${market} offer (direction ${direction})`, async () => {
      const o = await this.w.sol.client.getOffer(m.makerPda, ASSET[market], direction);
      const now = await this.w.sol.now();
      return o && o.enabled === 1 && now < o.updatedAt + BigInt(o.validSecs) ? o : null;
    }, { timeoutMs: 60_000 });
  }
  /** The maker's signed Ethereum quote for a market and direction, read from its board on Solana. */
  async boardQuote(m: Maker, market: Market, direction: 0 | 1) {
    const eth = this.w.eth!;
    return waitFor(`a live ${market} board quote (direction ${direction})`, async () => {
      const board = await this.w.sol.client.getEthBoard(m.makerPda);
      const now = await eth.now();
      for (const s of board?.slots ?? []) {
        if (s.used !== 1) continue;
        const q = decodeSignedQuote(Uint8Array.from([...s.quote, ...s.sig]));
        const usdc = hex0x(q.quote.token).toLowerCase() === eth.usdc.toLowerCase();
        if (q.quote.direction === direction && usdc === (market === 'usdc_eth') && q.quote.validUntil > now + 30n) return q;
      }
      return null;
    }, { timeoutMs: 60_000 });
  }

  async open(market: Market, direction: 0 | 1, xmr: bigint, o: { maker?: Maker; approval?: SignedSolApproval; slippageBps?: number; /** Ethereum: do not upload the taker's DLEQ proof (unusable input). */ withoutProof?: boolean; /** Ethereum direction A: which free pool leaf to name (0 = the first). */ leafRandom?: () => number; /** Ethereum: an advance approval to present. */ ethApproval?: { approval: EthApproval; sig: Uint8Array }; /** Runs after the open is planned (offer or quote read, proofs exchanged) and before it is sent. */ beforeSend?: () => Promise<void> } = {}): Promise<Opened> {
    const w = this.w;
    const m = o.maker ?? w.maker;
    if (market === 'sol' || market === 'usdc_sol') {
      const offer = await this.offer(m, market, direction);
      const maker = (await w.sol.client.getMaker(m.makerPda))!;
      const plan = planSolanaOpen({ program: w.sol.client.program, taker: this.solKey.publicKey, makerPda: m.makerPda, maker, seed: this.seed, xmr, source: { offer }, rentExemptMinimum: w.sol.rent0, slippageBps: o.slippageBps ?? 10, ...(o.approval ? { approval: o.approval } : {}) });
      if (o.beforeSend) await o.beforeSend();
      await w.sol.send(plan.instructions, [this.solKey]);
      this.solSession.set(plan.swapPda, seedSigner(plan.keys.sessionSecret));
      this.register(plan.swapPda, plan.keys);
      return { chain: 'solana', market, direction, ref: plan.swapPda, swapId: null, keys: plan.keys, amount: plan.amount, deposit: plan.deposit, maker: m };
    }
    const eth = w.eth!;
    const key = this.ethKey!;
    const { quote, sig } = await this.boardQuote(m, market, direction);
    const http = this.http(m);
    const swapNonce = newSwapNonce();
    const keys = takerSwapKeys(this.seed, 'ethereum', swapNonce);
    const solMaker = (await w.sol.client.getMaker(m.makerPda))!;
    let leaf: ReturnType<typeof leafArgument> | undefined;
    if (direction === 0) {
      // The pool hashes to the signed root; the picked leaf's proof verifies and is not one of ours.
      const pool = await fetchPool(http, quote.keyRoot);
      const picked = await pickLeaf(pool, { isKeyUsed: (k) => eth.client.isKeyUsed(m.ethMaker, k, 'latest'), ...(o.leafRandom ? { random: o.leafRandom } : {}) });
      await fetchProof(http, { spendPub: picked.spendPub, keyAddr: picked.key, keyAddr2: picked.key2 }, [keys.spendPub]);
      leaf = leafArgument(pool, picked);
    }
    if (!o.withoutProof) await uploadOwnProof(http, keys.spend);
    const plan = planEthereumOpen({ contract: eth.client.contract, taker: key.address.toLowerCase() as Address, quote, sig, maker: { encKeyVersion: solMaker.encKeyVersion, encKey: solMaker.encKey }, seed: this.seed, swapNonce, xmr, sessionBudget: ethSessionBudget(5_000_000_000n), slippageBps: o.slippageBps ?? 10, ...(leaf ? { leaf } : {}), ...(o.ethApproval ? { approval: o.ethApproval } : {}) });
    if (market === 'usdc_eth') await eth.usdcApprove(key, direction === 0 ? plan.amount : plan.deposit);
    if (o.beforeSend) await o.beforeSend();
    await eth.send(plan.call, key);
    const ref = hex0x(plan.swapId);
    this.ethSession.set(ref, privateKeyToAccount(hex0x(plan.keys.sessionSecret)));
    this.register(ref, plan.keys);
    return { chain: 'ethereum', market, direction, ref, swapId: plan.swapId, keys: plan.keys, amount: plan.amount, deposit: plan.deposit, maker: m };
  }

  private register(ref: string, keys: DerivedKeys): void {
    this.w.addSecret(`sdk-taker.${ref.slice(0, 10)}.spend`, keys.spend);
    this.w.addSecret(`sdk-taker.${ref.slice(0, 10)}.encSecret`, keys.encSecret);
    this.w.addSecret(`sdk-taker.${ref.slice(0, 10)}.session`, keys.sessionSecret);
  }

  /** Lamports sitting on a Solana swap's session key (its budget, until a session-signed settlement sweeps it back). */
  async sessionLamports(o: Opened): Promise<bigint> {
    const k = this.solSession.get(o.ref);
    return k ? this.w.sol.balance(k.publicKey) : 0n;
  }

  async view(o: Opened): Promise<SwapView | null> {
    return o.chain === 'solana' ? this.w.sol.swap(o.ref) : this.w.eth!.swap(o.swapId!);
  }
  async must(o: Opened): Promise<SwapView> {
    const v = await this.view(o);
    if (!v) throw new Error(`swap ${o.ref} is gone`);
    return v;
  }

  /** Send one call on the swap. `by`: the session key (default), the taker's wallet, or a stranger (anyone-can-crank calls). */
  async call(o: Opened, call: FlowCall, m: CallMaterial = {}, by: 'session' | 'wallet' | 'stranger' = 'session', onState?: SwapView): Promise<string> {
    const w = this.w;
    const s = onState ?? (await this.must(o));
    if (o.chain === 'solana') {
      const signer = by === 'session' ? this.solSession.get(o.ref)! : by === 'wallet' ? this.solKey : w.sol.stranger;
      const mk = (await w.sol.client.getMaker(o.maker.makerPda))!;
      return w.sol.send([solanaInstruction(w.sol.client.program, s, { operator: mk.operator, payout: mk.payout }, signer.publicKey, call, m)], [signer]);
    }
    const signer = by === 'session' ? this.ethSession.get(o.ref)! : by === 'wallet' ? this.ethKey! : w.eth!.stranger;
    return w.eth!.send(ethereumCall(w.eth!.client.contract, s, call, m)!, signer, { secret: call.name === 'claim' || call.name === 'refund' });
  }
  refund(o: Opened, by: 'session' | 'wallet' = 'session'): Promise<string> {
    return this.call(o, { name: 'refund' }, { secret: o.keys.spend }, by);
  }
  claim(o: Opened): Promise<string> {
    return this.call(o, { name: 'claim' }, { secret: o.keys.spend });
  }

  /** Direction A: decrypt the maker's notice and derive the joint address it claims to have paid. */
  async notice(o: Opened): Promise<{ txid: string; view: Uint8Array; joint: ReturnType<typeof swapJointAddress> }> {
    const s = await this.must(o);
    const opened = openNotice(s, o.keys.encSecret);
    if (!opened) throw new Error('the notice does not open');
    return { txid: hex(opened.txid), view: opened.view, joint: swapJointAddress(s, opened.view, 'regtest') };
  }
  /** Verify the XMR lock on both nodes at the swap's depth (direction A), as the page does. */
  async verify(o: Opened, minConf?: number): Promise<VerifyLockResult> {
    const s = await this.must(o);
    const n = await this.notice(o);
    return verifyLock({ nodes: [NODE_A, NODE_B], txid: n.txid, viewPriv: hex(n.joint.viewPriv), spendPub: hex(n.joint.spendPub), minAmount: s.xmr, minConf: minConf ?? s.depth });
  }
  /** Direction A after the maker's share is public: take the XMR. Returns the sweep transaction id. */
  async sweep(o: Opened, last: SwapView, destination: string = this.w.takerXmr): Promise<{ txid: string; amount: bigint; fee: bigint }> {
    const n = await this.notice({ ...o });
    const lock = await verifyLock({ nodes: [NODE_A, NODE_B], txid: n.txid, viewPriv: hex(n.joint.viewPriv), spendPub: hex(n.joint.spendPub), minAmount: last.xmr, minConf: 10 });
    if (lock.blockHeight === undefined || lock.outputIndex === undefined) throw new Error(`the lock is not sweepable: ${JSON.stringify(lock.reasons)}`);
    const r = await sweepJoint({ daemonUrl: NODE_A, network: 'regtest', spendKey: jointSpendKey(last, o.keys.spend, 'taker'), viewKey: n.joint.viewPriv, lockHeight: lock.blockHeight, lockTxid: unhex(n.txid), outputIndex: BigInt(lock.outputIndex), destination, maxFee: REGTEST_MAX_FEE, publish: true });
    return { txid: r.txid, amount: r.amount, fee: r.fee };
  }

  /** Direction B: the joint address once the maker has funded (Ethereum: only after its proof for the funded share verifies). */
  async payAddress(o: Opened): Promise<string> {
    const s = await this.must(o);
    if (o.chain === 'ethereum') {
      const blob = await fetchProof(this.http(o.maker), { spendPub: s.makerSpendPub, keyAddr: s.eth!.makerKey as Address, keyAddr2: s.eth!.makerKey2 as Address }, [o.keys.spendPub]);
      verifyFundedShare(blob, s);
    }
    return swapJointAddress(s, o.keys.view, 'regtest').address;
  }
  /** Direction B: announce a payment (any transaction id: a real one, or a false one). */
  async postNotice(o: Opened, txid: string): Promise<string> {
    const s = await this.must(o);
    return this.call(o, { name: 'post_notice' }, { notice: buildNotice(s, o.keys.encSecret, unhex(txid), o.keys.view) });
  }
}
