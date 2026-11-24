/**
 * Opening swaps (SPEC 4.4, 5.3, 6.4, 8.6): one `lock` or `take`, or a wave of them, built by
 * the SDK's open plans and signed by the user's wallet. This is the only step of a swap that
 * needs a wallet prompt; everything after it is signed by the per-swap session key.
 */
import { PublicKey, type TransactionInstruction } from '@solana/web3.js';
import type { Address, ChainName } from '@xmrswap/protocol';
import {
  type EthereumClient,
  MakerHttp,
  type SignedSolApproval,
  type SolanaClient,
  type SwapView,
  TransportUnavailable,
  blobRouteAvailable,
  directEndpoint,
  ethQuoteProblem,
  ethSessionBudget,
  fetchPool,
  fetchProof,
  hex0x,
  leafArgument,
  newSwapNonce,
  offerProblem,
  pickLeaf,
  planEthereumOpen,
  planSolanaOpen,
  relayEndpoint,
  takerSwapKeys,
  unhex,
  uploadOwnProof,
  verifyFundedShare,
} from '@xmrswap/sdk';
import { encodeFunctionData, erc20Abi } from 'viem';
import type { OfferRow, UpgradeStatus } from './market.js';
import type { EthereumPort, SolanaPort } from './ports.js';
import { type Settings, relayUrlOf } from './settings.js';

export class OpenRefused extends Error {}

const PROBLEM: Readonly<Record<string, string>> = {
  Paused: 'The maker paused new swaps a moment ago. Nothing was locked.',
  OfferDisabled: 'The maker switched this offer off a moment ago. Nothing was locked.',
  OfferStale: 'This offer lapsed: the maker has not refreshed it. Nothing was locked.',
  TermsChanged: 'The maker changed the terms of this offer after you reviewed them. Nothing was locked; review the new terms.',
  SeqTooOld: 'The maker changed this offer after you reviewed it. Nothing was locked; review it again.',
};

export interface SolanaLeg {
  row: OfferRow;
  xmr: bigint;
}

/** Build the open plans of a set of Solana legs against the offers as they stand now, refusing any whose terms changed since review. */
export async function planSolanaLegs(client: SolanaClient, taker: string, seed: Uint8Array, legs: readonly SolanaLeg[], slippageBps: number, approvals: (makerPda: string) => SignedSolApproval | undefined) {
  const now = await client.chainTime();
  const rent0 = await client.transport.getMinimumBalanceForRentExemption(0);
  const plans = [];
  for (const leg of legs) {
    if (!('offer' in leg.row.source)) throw new OpenRefused('Not a Solana offer.');
    const reviewed = leg.row.source.offer;
    const makerPda = leg.row.maker.pda;
    const maker = await client.getMaker(makerPda);
    const offer = await client.getOffer(makerPda, reviewed.asset, reviewed.direction);
    if (!maker || !offer) throw new OpenRefused('This offer is gone from the registry. Nothing was locked.');
    const problem = offerProblem(offer, maker, now, { termsHash: reviewed.termsHash });
    if (problem) throw new OpenRefused(PROBLEM[problem] ?? `The offer cannot be locked against (${problem}). Nothing was locked.`);
    const approval = approvals(makerPda);
    if (offer.mode === 2 && !approval) throw new OpenRefused('This maker only accepts takers it approved in advance. Ask for an approval on the maker page first. Nothing was locked.');
    plans.push(planSolanaOpen({ program: client.program, taker, makerPda, maker, seed, xmr: leg.xmr, source: { offer }, slippageBps, rentExemptMinimum: rent0, ...(approval ? { approval } : {}) }));
  }
  return plans;
}

/**
 * Open Solana legs, grouped into transactions as the router packed them (SPEC 4.10: two SOL legs
 * per transaction, one USDC leg). One wallet prompt per transaction. Returns the swaps that
 * opened; a group the wallet refused or the program rejected opens nothing and is reported.
 */
export async function openSolanaWave(port: SolanaPort, taker: string, seed: Uint8Array, legs: readonly SolanaLeg[], groups: readonly number[][], slippageBps: number, approvals: (makerPda: string) => SignedSolApproval | undefined = () => undefined): Promise<{ opened: (SwapView | null)[]; errors: (string | null)[] }> {
  const plans = await planSolanaLegs(port.client, taker, seed, legs, slippageBps, approvals);
  const opened: (SwapView | null)[] = legs.map(() => null);
  const errors: (string | null)[] = legs.map(() => null);
  for (const group of groups) {
    const ixs: TransactionInstruction[] = group.flatMap((i) => plans[i]!.instructions);
    try {
      await port.sendWithWallet(ixs);
      for (const i of group) opened[i] = await port.client.getSwap(plans[i]!.swapPda);
    } catch (e) {
      for (const i of group) errors[i] = e instanceof Error ? e.message : String(e);
    }
  }
  return { opened, errors };
}

export async function openSolana(port: SolanaPort, taker: string, seed: Uint8Array, row: OfferRow, xmr: bigint, slippageBps: number, approval?: SignedSolApproval): Promise<SwapView> {
  const r = await openSolanaWave(port, taker, seed, [{ row, xmr }], [[0]], slippageBps, () => approval);
  if (r.errors[0]) throw new OpenRefused(r.errors[0]);
  if (!r.opened[0]) throw new Error('The lock was sent but the swap account cannot be read yet. Open Activity: it will appear there.');
  return r.opened[0];
}

// ------------------------------------------------------------------ Ethereum

/** The route to a maker's blob endpoint (pool leaves and DLEQ proofs) in the current connection mode, or `null`. */
export function makerHttp(maker: OfferRow['maker'], settings: Settings): MakerHttp | null {
  if (settings.mode === 'tor-direct' && maker.onion) return new MakerHttp(directEndpoint(`http://${maker.onion}`));
  const relay = relayUrlOf(settings);
  const route = blobRouteAvailable({ onion: maker.onion ?? '', contacts: maker.solana.contacts }, relay);
  if (route === 'relay' && relay && maker.onion) return new MakerHttp(relayEndpoint(relay, maker.onion));
  if (route === 'https' && maker.blobEndpoint) return new MakerHttp(directEndpoint(maker.blobEndpoint));
  return null;
}

export const NO_BLOB_ROUTE = 'Ethereum swaps need the maker\'s key proofs, which are too large for any chain. Neither the relay nor a direct route to this maker\'s endpoint is available in the current connection mode, so nothing can be locked. Switch to a relay mode in Settings.';

export async function openEthereum(port: EthereumPort, taker: Address, seed: Uint8Array, row: OfferRow, xmr: bigint, slippageBps: number, settings: Settings): Promise<SwapView> {
  if (!('quote' in row.source)) throw new OpenRefused('Not an Ethereum quote.');
  const { quote, sig } = row.source;
  const client: EthereumClient = port.client;
  const http = makerHttp(row.maker, settings);
  if (!http) throw new OpenRefused(NO_BLOB_ROUTE);
  if (!row.maker.ethereum) throw new OpenRefused('This maker has no Ethereum registration.');
  const d = { chainId: settings.ethereumChainId, contract: settings.contract as Address };
  const now = await client.chainTime('latest');
  const rec = row.maker.ethereum.record;
  const cancelled = await client.isQuoteCancelled(row.maker.ethereum.address, quote.quoteId, 'latest');
  const problem = await ethQuoteProblem(d, quote, sig, { operator: rec.operator, quoteEpoch: rec.quoteEpoch, approvalEpoch: rec.approvalEpoch, paused: rec.paused }, { now, direction: row.direction, sender: taker, cancelled });
  if (problem) throw new OpenRefused(`This quote can no longer be used (${problem}). Nothing was locked; refresh the offers.`);

  const swapNonce = newSwapNonce();
  const keys = takerSwapKeys(seed, 'ethereum', swapNonce);
  // The maker checks our proof before it approves or funds; without it the swap is rejected.
  await uploadOwnProof(http, keys.spend);
  let leaf;
  if (row.direction === 0) {
    const pool = await fetchPool(http, quote.keyRoot);
    const picked = await pickLeaf(pool, { isKeyUsed: (k) => client.isKeyUsed(row.maker.ethereum!.address, k, 'latest') });
    // Never lock against a share whose proof does not verify: the claim could not be checked.
    await fetchProof(http, { spendPub: picked.spendPub, keyAddr: picked.key, keyAddr2: picked.key2 }, [keys.spendPub]);
    leaf = leafArgument(pool, picked);
  }
  const sessionBudget = await ethereumSessionBudget(client);
  const plan = planEthereumOpen({ contract: client.contract, taker, quote, sig, maker: { encKeyVersion: row.maker.solana.encKeyVersion, encKey: row.maker.solana.encKey }, seed, swapNonce, xmr, slippageBps, sessionBudget, ...(leaf ? { leaf } : {}) });
  const token = hex0x(quote.token) as Address;
  if (row.market === 'usdc_eth') {
    const need = row.direction === 0 ? plan.limit : plan.deposit;
    const allowanceHex = (await client.transport.request({ method: 'eth_call', params: [{ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'allowance', args: [taker, client.contract.address] }) }, 'latest'] })) as string;
    if (BigInt(allowanceHex) < need) await port.sendWithWallet({ to: token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [client.contract.address, need] }), value: 0n });
  }
  await port.sendWithWallet(plan.call);
  const view = await client.getSwap(plan.swapId, 'latest', true);
  if (!view) throw new Error('The lock was sent but the swap cannot be read yet. Open Activity: it will appear there.');
  return view;
}

/** What the lock forwards to the session key on Ethereum: four calls at twice the base fee plus a tip. What is left is swept back to the taker. */
export async function ethereumSessionBudget(client: EthereumClient): Promise<bigint> {
  const base = BigInt(((await client.transport.request({ method: 'eth_getBlockByNumber', params: ['latest', false] })) as { baseFeePerGas?: string }).baseFeePerGas ?? '0x0');
  return ethSessionBudget(base * 2n + 2_000_000_000n);
}

/** The outcome of one attempt to check the maker's proof: verified, proven wrong, or not obtainable right now (and why). */
export type ProofResult = { ok: true } | { ok: false } | { retry: string };

/**
 * Ethereum direction B: the maker's proof for the share it funded with (SPEC 6.4). A proof that
 * does not verify is final for that swap; everything else (no route, not served yet, the relay
 * or the maker not answering) is a condition to show and retry.
 */
export async function checkFundedShare(s: SwapView, http: MakerHttp | null): Promise<ProofResult> {
  if (!http) return { retry: 'There is no route to the maker\'s proof endpoint in the current connection mode (a relay or the maker\'s HTTPS endpoint is needed)' };
  let blob: Uint8Array | null;
  try {
    blob = await http.getDleq(Array.from(s.makerSpendPub, (b) => b.toString(16).padStart(2, '0')).join(''));
  } catch (e) {
    if (e instanceof TransportUnavailable) return { retry: e.relayError ? `The relay refused the proof download (${e.relayError})` : 'The relay or the maker\'s endpoint did not answer' };
    return { retry: e instanceof Error ? e.message : String(e) };
  }
  if (!blob) return { retry: 'The maker\'s endpoint is not serving the proof for this share yet' };
  try {
    verifyFundedShare(blob, s);
    return { ok: true };
  } catch {
    return { ok: false };
  }
}

// ------------------------------------------------------------------ upgrade status (SPEC 8.5 item 10, 8.2 "Status")

const UPGRADEABLE_LOADER = 'BPFLoaderUpgradeab1e11111111111111111111111';

/** Whether the Solana program can still be upgraded: the upgrade authority in its ProgramData account. */
export async function solanaUpgradeStatus(client: SolanaClient): Promise<UpgradeStatus> {
  try {
    const program = await client.transport.getAccount(client.programId);
    if (!program) return { frozen: null, authority: null };
    if (program.owner !== UPGRADEABLE_LOADER) return { frozen: true, authority: null };
    const programData = new PublicKey(program.data.slice(4, 36)).toBase58();
    const data = (await client.transport.getAccount(programData))?.data;
    if (!data || data.length < 13) return { frozen: null, authority: null };
    if (data[12] === 0) return { frozen: true, authority: null };
    return { frozen: false, authority: new PublicKey(data.slice(13, 45)).toBase58() };
  } catch {
    return { frozen: null, authority: null };
  }
}

/** Whether the Ethereum contract can still be upgraded: `owner()` of the proxy (zero once ownership is renounced). */
export async function ethereumUpgradeStatus(client: EthereumClient): Promise<UpgradeStatus> {
  try {
    const r = (await client.transport.request({ method: 'eth_call', params: [{ to: client.contract.address, data: '0x8da5cb5b' }, 'latest'] })) as string;
    if (!/^0x[0-9a-fA-F]{64}$/.test(r)) return { frozen: null, authority: null };
    const owner = `0x${r.slice(26)}`;
    return /^0x0{40}$/.test(owner) ? { frozen: true, authority: null } : { frozen: false, authority: owner };
  } catch {
    return { frozen: null, authority: null };
  }
}

export const chainOfRow = (r: OfferRow): ChainName => r.chain;
export { unhex };
