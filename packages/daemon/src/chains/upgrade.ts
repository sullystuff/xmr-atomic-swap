/**
 * Whether the contracts can still be upgraded (DESIGN "Upgrades, then immutability": the UI
 * must state the current status). Read from chain state, never assumed.
 *
 * Solana: the program account names its ProgramData account; that account's upgrade authority
 * is present (upgradable, by that key) or absent (immutable). Ethereum: the proxy's owner is
 * the only key that can upgrade; after `renounceOwnership()` it is the zero address and no
 * upgrade can ever pass.
 */
import { PublicKey } from '@solana/web3.js';
import type { EthTransport, SolanaTransport } from '@xmrswap/sdk';

export interface UpgradeStatus {
  status: 'upgradable' | 'immutable' | 'unknown';
  /** Who can upgrade: the program's upgrade authority (base58) or the proxy's owner (0x). `null` when nobody can, or unknown. */
  authority: string | null;
  /** Ethereum: an ownership transfer waiting to be accepted (Ownable2Step). */
  pending_authority: string | null;
  /** Ethereum: the implementation behind the proxy (ERC-1967 slot). Solana: the ProgramData account. */
  implementation: string | null;
  /** Why the status is unknown, in plain words. */
  reason: string | null;
  checked_at: number;
}

export const LOADER_UPGRADEABLE = 'BPFLoaderUpgradeab1e11111111111111111111111';
const LOADERS_FINAL = ['BPFLoader2111111111111111111111111111111111', 'BPFLoader1111111111111111111111111111111111'];
const unknown = (reason: string, at: number): UpgradeStatus => ({ status: 'unknown', authority: null, pending_authority: null, implementation: null, reason, checked_at: at });
const u32 = (d: Uint8Array, o: number): number => new DataView(d.buffer, d.byteOffset).getUint32(o, true);

export async function solanaUpgradeStatus(transport: SolanaTransport, programId: string, at: number): Promise<UpgradeStatus> {
  try {
    const program = await transport.getAccount(programId, 'finalized');
    if (!program) return unknown('the program account was not found at this endpoint', at);
    if (LOADERS_FINAL.includes(program.owner)) return { status: 'immutable', authority: null, pending_authority: null, implementation: null, reason: null, checked_at: at };
    if (program.owner !== LOADER_UPGRADEABLE) return unknown(`the program is owned by an unrecognised loader (${program.owner})`, at);
    // UpgradeableLoaderState::Program: u32 tag 2, then the ProgramData address.
    if (program.data.length < 36 || u32(program.data, 0) !== 2) return unknown('the program account is not in the upgradeable loader\'s Program layout', at);
    const programData = new PublicKey(program.data.subarray(4, 36)).toBase58();
    const pd = await transport.getAccount(programData, 'finalized');
    if (!pd) return unknown('the ProgramData account was not found at this endpoint', at);
    // UpgradeableLoaderState::ProgramData: u32 tag 3, u64 slot, Option<Pubkey>.
    if (pd.owner !== LOADER_UPGRADEABLE || pd.data.length < 13 || u32(pd.data, 0) !== 3) return unknown('the ProgramData account is not in the expected layout', at);
    if (pd.data[12] === 0) return { status: 'immutable', authority: null, pending_authority: null, implementation: programData, reason: null, checked_at: at };
    if (pd.data[12] !== 1 || pd.data.length < 45) return unknown('the ProgramData account is not in the expected layout', at);
    return { status: 'upgradable', authority: new PublicKey(pd.data.subarray(13, 45)).toBase58(), pending_authority: null, implementation: programData, reason: null, checked_at: at };
  } catch (e) {
    return unknown(`the endpoint could not be read: ${(e as Error).message}`, at);
  }
}

const OWNER = '0x8da5cb5b'; // owner()
const PENDING_OWNER = '0xe30c3978'; // pendingOwner()
const IMPLEMENTATION_SLOT = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
const asAddress = (word: unknown): string | null => (typeof word === 'string' && /^0x[0-9a-fA-F]{64}$/.test(word) ? `0x${word.slice(26).toLowerCase()}` : null);
const isZero = (a: string | null): boolean => a !== null && /^0x0{40}$/.test(a);

export async function ethereumUpgradeStatus(transport: EthTransport, proxy: string, tag: 'finalized' | 'safe' | 'latest', at: number): Promise<UpgradeStatus> {
  try {
    const owner = asAddress(await transport.request({ method: 'eth_call', params: [{ to: proxy, data: OWNER }, tag] }));
    if (owner === null) return unknown('the contract did not answer owner() (not deployed at this block, or not this contract)', at);
    const [pending, impl] = await Promise.all([
      transport.request({ method: 'eth_call', params: [{ to: proxy, data: PENDING_OWNER }, tag] }).then(asAddress, () => null),
      transport.request({ method: 'eth_getStorageAt', params: [proxy, IMPLEMENTATION_SLOT, tag] }).then(asAddress, () => null),
    ]);
    const implementation = impl && !isZero(impl) ? impl : null;
    if (isZero(owner)) return { status: 'immutable', authority: null, pending_authority: null, implementation, reason: null, checked_at: at };
    return { status: 'upgradable', authority: owner, pending_authority: pending && !isZero(pending) ? pending : null, implementation, reason: null, checked_at: at };
  } catch (e) {
    return unknown(`the endpoint could not be read: ${(e as Error).message}`, at);
  }
}
