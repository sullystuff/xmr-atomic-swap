/**
 * The registry reader: makers, their offers and verified Ethereum quotes, each with the maker's
 * merged cross-chain history (SPEC 4.2 client queries, 5.6, 8.2 "Offers").
 */
import type { EthQuote } from '@xmrswap/core-wasm';
import { type Address, CONTACT_KIND, type Maker, type Offer } from '@xmrswap/protocol';
import type { EthMaker, EthereumClient } from '../ethereum/client.js';
import { type EthDeployment, verifyBoardQuote } from '../signing/eip712.js';
import { offerProblem } from '../signing/solana.js';
import type { SolanaClient } from '../solana/client.js';
import type { Bytes } from '../util.js';
import { type LinkMemory, type MakerCounters, type MergedIdentity, effectiveEthLink, ethAddressHex, everMutuallyLinked, mergeCounters, mergedReputation, pastEthLinks, reputationOf } from './reputation.js';

export interface MakerProfile {
  /** Maker PDA, base58. */
  pda: string;
  solana: Maker;
  /** The Ethereum record the Solana record points at, when it exists. */
  ethereum: { address: Address; record: EthMaker } | null;
  identity: MergedIdentity;
  /** v3 onion host, or `null`. */
  onion: string | null;
  /** HTTPS blob endpoint (contact kind 5), or `null`. */
  blobEndpoint: string | null;
}

export interface RegistryClock {
  solana: bigint;
  ethereum: bigint;
}

/**
 * One maker's profile from its Solana record and the Ethereum records that are, or ever were,
 * the same identity: the one its pointer names now, and every address `memory` remembers as
 * once mutually linked (fill it from chain history with `rememberPastLinks`). History stays
 * attached to both keys after an unlink, so a bad record cannot be shed.
 */
export async function makerProfile(pda: string, solana: Maker, ethereum: EthereumClient | null, now: RegistryClock, memory?: LinkMemory): Promise<MakerProfile> {
  const pointer = effectiveEthLink(solana, now.solana);
  const toLink = (address: Address, record: EthMaker) => ({ address, solanaOwner: record.solanaOwner, solanaOwnerNext: record.solanaOwnerNext, solanaOwnerNextAt: record.solanaOwnerNextAt, counters: record.counters, responseSecsSum: record.responseSecsSum });
  let eth: MakerProfile['ethereum'] = null;
  if (pointer && ethereum) {
    const address = ethAddressHex(pointer) as Address;
    const record = await ethereum.getMaker(address);
    if (record) eth = { address, record };
  }
  let identity = mergedReputation(solana, eth ? toLink(eth.address, eth.record) : null, now, memory);
  // Records that were once this identity but are no longer what the pointer names.
  const past = (memory?.ethereumOf(solana.owner) ?? []).filter((a) => a !== eth?.address);
  if (ethereum && past.length) {
    const records = [solana as MakerCounters];
    if (identity.merged && eth) records.push(eth.record);
    let any = false;
    for (const address of past) {
      const record = await ethereum.getMaker(address as Address);
      if (!record) continue;
      records.push(record);
      any = true;
      if (!eth) eth = { address: address as Address, record };
    }
    if (any) identity = { ...identity, merged: true, historical: true, reputation: reputationOf(mergeCounters(records)) };
  }
  const blob = solana.contacts.find((c) => c.kind === CONTACT_KIND.BLOB_ENDPOINT && /^https:\/\//.test(c.value));
  return { pda, solana, ethereum: eth, identity, onion: solana.onion || null, blobEndpoint: blob?.value ?? null };
}

/**
 * Fill `memory` from chain history: read the maker's `LinkChanged` events on Solana, and for
 * every Ethereum address it ever pointed at, that record's link history (`MakerRegistered`,
 * `LinkChanged`); remember each pair that was mutually in effect at some time. A fresh client
 * calls this before `makerProfile`, so a maker cannot shed a record by unlinking. Returns the
 * addresses remembered. `fromBlock` is the contract's deployment block.
 */
export async function rememberPastLinks(solana: SolanaClient, ethereum: EthereumClient, pda: string, maker: Maker, memory: LinkMemory, now: RegistryClock, fromBlock = 0n): Promise<string[]> {
  const solChanges = await solana.linkChanges(pda);
  const found: string[] = [];
  for (const address of pastEthLinks(solChanges, now.solana)) {
    const ethChanges = await ethereum.linkChanges(address as Address, { fromBlock, toBlock: 'finalized' });
    if (!everMutuallyLinked(solChanges, ethChanges, maker.owner, address, now)) continue;
    memory.remember(maker.owner, address);
    found.push(address);
  }
  return found;
}

/** Every maker in the registry with its merged history. */
export async function listMakerProfiles(solana: SolanaClient, ethereum: EthereumClient | null, now: RegistryClock, memory?: LinkMemory): Promise<MakerProfile[]> {
  const makers = await solana.listMakers();
  return Promise.all(makers.map((m) => makerProfile(m.pubkey, m.account, ethereum, now, memory)));
}

export interface ListedOffer {
  pubkey: string;
  offer: Offer;
  maker: MakerProfile;
  /** `null` = a lock against it would be accepted right now as far as the offer itself goes. */
  problem: ReturnType<typeof offerProblem>;
}

/** Live Solana offers for one asset and direction, each with its maker's profile. Offers that cannot be locked against are kept and flagged. */
export async function listOffers(solana: SolanaClient, makers: readonly MakerProfile[], want: { asset: number; direction: number }, now: bigint): Promise<ListedOffer[]> {
  const byPda = new Map(makers.map((m) => [m.pda, m]));
  const offers = await solana.listOffers();
  const out: ListedOffer[] = [];
  for (const o of offers) {
    const maker = byPda.get(o.account.maker);
    if (!maker || o.account.asset !== want.asset || o.account.direction !== want.direction) continue;
    out.push({ pubkey: o.pubkey, offer: o.account, maker, problem: offerProblem(o.account, maker.solana, now) });
  }
  return out;
}

export interface ListedEthQuote {
  maker: MakerProfile;
  slot: number;
  quote: EthQuote;
  sig: Bytes;
}

/**
 * The verified Ethereum quotes of one maker's board. A slot is shown only if its `maker` field
 * is the Ethereum address **mutually** linked to the board's owner and its signature recovers
 * to the operator registered in the Ethereum contract; everything else is discarded silently
 * (the reasons are returned for the status page).
 */
export async function verifiedBoardQuotes(solana: SolanaClient, maker: MakerProfile, d: EthDeployment, nowEthereum: bigint): Promise<{ quotes: ListedEthQuote[]; discarded: { slot: number; reason: string }[] }> {
  const board = await solana.getEthBoard(maker.pda);
  const quotes: ListedEthQuote[] = [];
  const discarded: { slot: number; reason: string }[] = [];
  if (!board) return { quotes, discarded };
  const linked = maker.identity.link.status === 'mutual' && maker.ethereum ? maker.ethereum : null;
  for (const [slot, s] of board.slots.entries()) {
    if (s.used === 0) continue;
    if (!linked) {
      discarded.push({ slot, reason: 'NotLinked' });
      continue;
    }
    const r = await verifyBoardQuote(d, { quote: s.quote, sig: s.sig }, { linkedEthMaker: linked.address, maker: linked.record, now: nowEthereum });
    if (r.ok) quotes.push({ maker, slot, quote: r.quote, sig: r.sig });
    else discarded.push({ slot, reason: r.reason });
  }
  return { quotes, discarded };
}
