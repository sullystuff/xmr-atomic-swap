/** Program-derived addresses of SPEC 4.1 and the token accounts the program expects. */
import { ASSOCIATED_TOKEN_PROGRAM_ID, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { PublicKey } from '@solana/web3.js';
import { SEED } from '@xmrswap/protocol';
import { type Bytes, bigToLe, utf8 } from '../util.js';

export type Key = PublicKey | string;
export const pk = (k: Key): PublicKey => (typeof k === 'string' ? new PublicKey(k) : k);

const find = (programId: Key, ...seeds: Bytes[]): PublicKey => PublicKey.findProgramAddressSync(seeds, pk(programId))[0];

export const configPda = (programId: Key): PublicKey => find(programId, utf8(SEED.config));
export const treasuryPda = (programId: Key): PublicKey => find(programId, utf8(SEED.treasury));
export const treasuryVaultPda = (programId: Key, mint: Key): PublicKey => find(programId, utf8(SEED.treasuryVault), pk(mint).toBytes());
/** `["maker", owner]`. */
export const makerPda = (programId: Key, owner: Key): PublicKey => find(programId, utf8(SEED.maker), pk(owner).toBytes());
/** `["offer", maker PDA, [asset], [direction]]`. */
export const offerPda = (programId: Key, maker: Key, asset: number, direction: number): PublicKey =>
  find(programId, utf8(SEED.offer), pk(maker).toBytes(), Uint8Array.of(asset), Uint8Array.of(direction));
export const ethBoardPda = (programId: Key, maker: Key): PublicKey => find(programId, utf8(SEED.ethBoard), pk(maker).toBytes());
/** `["quote", maker PDA, quote_id (u64 LE)]`. */
export const quotePda = (programId: Key, maker: Key, quoteId: bigint): PublicKey => find(programId, utf8(SEED.quote), pk(maker).toBytes(), bigToLe(quoteId, 8));
/** `["swap", taker, swap_nonce[16]]`: computable before the lock transaction is sent; it is the swap's `swap_ref`. */
export function swapPda(programId: Key, taker: Key, swapNonce: Bytes): PublicKey {
  if (swapNonce.length !== 16) throw new Error('a swap nonce is 16 bytes');
  return find(programId, utf8(SEED.swap), pk(taker).toBytes(), swapNonce);
}
/** `["vault", swap PDA]`: the swap's USDC vault. */
export const vaultPda = (programId: Key, swap: Key): PublicKey => find(programId, utf8(SEED.vault), pk(swap).toBytes());

/** The associated token account of `owner` for `mint` (classic Token program only). */
export const ata = (owner: Key, mint: Key): PublicKey => getAssociatedTokenAddressSync(pk(mint), pk(owner), true, TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID);

export { TOKEN_PROGRAM_ID };
