/**
 * The optional wallet-derived key (Amendment 1, SPEC 11.3): the swap seed comes from one wallet
 * signature over a fixed message, so swaps can be resumed from any device that has the wallet.
 * Off by default; the recovery file stays the default and stays available in this mode.
 *
 * The messages are fixed strings of `@xmrswap/protocol`, the derivation is the core's
 * (`walletSeed`), and the rules are enforced here:
 *
 *  - the signature must be the wallet's own over exactly the message of this deployment (a
 *    signature made for another site string, cluster, program, chain id or contract is refused);
 *  - **determinism**: on first use the wallet signs twice and the bytes must be equal;
 *  - **returning user**: one signature, and the seed must re-derive the spend commitment stored
 *    in each of the wallet's swaps found on chain; a mismatch refuses the mode;
 *  - the signature is passed to the core and dropped: never stored, never sent.
 *
 * The seed is per chain and wallet: Solana swaps use the Solana wallet's seed, Ethereum swaps
 * the Ethereum wallet's.
 */
import { ed25519 } from '@noble/curves/ed25519.js';
import { CHAIN_TAG, walletKeySolanaMessage as coreSolanaMessage, normalizeEthSignature, walletKeyDigest, walletSeed } from '@xmrswap/core-wasm';
import { type Address, type ChainName, EIP712_TYPES, type RecoveryFilePlain, WALLET_KEY_SITE, type WalletKeyMessage, base58Decode, eip712Domain, walletKeyMessage, walletKeySolanaMessage } from '@xmrswap/protocol';
import { recoverAddress } from 'viem';
import { takerSwapKeys } from '../flows/keys.js';
import { createRecoveryFile } from '../recovery/file.js';
import { type Bytes, SdkError, bytesEqual, hex0x, unhex, utf8 } from '../util.js';

/** Which deployment a wallet key is for: the fields that go into the signed message. */
export type WalletKeyContext =
  | { chain: 'solana'; /** Base58. */ wallet: string; /** The cluster's genesis hash, base58 (`getGenesisHash`). */ genesisHash: string; programId: string; site?: string }
  | { chain: 'ethereum'; wallet: Address; chainId: bigint | number; /** The proxy address. */ contract: Address; site?: string };

/** The exact bytes a Solana wallet signs with `signMessage` (UTF-8, LF, no trailing newline), and the text to show. */
export function walletKeySolanaRequest(c: Extract<WalletKeyContext, { chain: 'solana' }>): { text: string; bytes: Bytes } {
  const site = c.site ?? WALLET_KEY_SITE;
  const text = walletKeySolanaMessage({ genesisHash: c.genesisHash, programId: c.programId, wallet: c.wallet, site });
  const bytes = utf8(text);
  // One implementation of the message in the protocol package, one in the core: they must agree.
  if (!bytesEqual(bytes, coreSolanaMessage(site, key32(c.genesisHash, 'genesis hash'), key32(c.programId, 'program id'), key32(c.wallet, 'wallet')))) throw new SdkError('WalletMessageMismatch', 'the wallet-key message of the protocol package and of the core differ');
  return { text, bytes };
}

/** The typed data an Ethereum wallet signs with `eth_signTypedData_v4`, under the contract's own domain so the wallet displays it. */
export function walletKeyTypedData(c: Extract<WalletKeyContext, { chain: 'ethereum' }>) {
  const message: WalletKeyMessage = walletKeyMessage(c.wallet.toLowerCase() as Address, c.site ?? WALLET_KEY_SITE);
  return {
    domain: eip712Domain(c.chainId, c.contract),
    types: { WalletKey: EIP712_TYPES.WalletKey },
    primaryType: 'WalletKey' as const,
    message,
  };
}

function key32(base58: string, what: string): Bytes {
  let b: Bytes;
  try {
    b = base58Decode(base58);
  } catch {
    b = new Uint8Array(0);
  }
  if (b.length !== 32) throw new SdkError('BadKey', `the ${what} is not a 32-byte base58 key`);
  return b;
}
const walletBytes = (c: WalletKeyContext): Bytes => (c.chain === 'solana' ? key32(c.wallet, 'wallet') : unhex(c.wallet));

/**
 * Whether `signature` is this wallet's signature over the wallet-key message of exactly this
 * deployment. Solana: Ed25519 over the message bytes. Ethereum: the EIP-712 digest under the
 * contract's domain must recover the wallet's address (so a contract wallet, or a signature
 * made under another domain or site, fails).
 */
export async function walletSignatureValid(c: WalletKeyContext, signature: Bytes): Promise<boolean> {
  try {
    if (c.chain === 'solana') {
      if (signature.length !== 64) return false;
      return ed25519.verify(signature, walletKeySolanaRequest(c).bytes, key32(c.wallet, 'wallet'));
    }
    const digest = walletKeyDigest({ chainId: BigInt(c.chainId), verifyingContract: unhex(c.contract) }, c.site ?? WALLET_KEY_SITE, unhex(c.wallet));
    const recovered = await recoverAddress({ hash: hex0x(digest), signature: hex0x(normalizeEthSignature(signature)) });
    return recovered.toLowerCase() === c.wallet.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * `walletSeed` behind the signature check: the 32-byte swap seed, or `WalletSignatureInvalid`
 * when the signature is not this wallet's over this deployment's message. Every spelling of one
 * Ethereum signature (high s, `v` 0/1) gives one seed. The caller drops the signature.
 */
export async function deriveWalletSeed(c: WalletKeyContext, signature: Bytes): Promise<Bytes> {
  if (!(await walletSignatureValid(c, signature))) throw new SdkError('WalletSignatureInvalid', 'not a signature of this wallet over the wallet-key message of this site and deployment');
  return walletSeed(CHAIN_TAG[c.chain], walletBytes(c), signature);
}

/** A swap of the wallet as found on chain: what a returning user's seed is proved against. */
export interface KnownSwap {
  swapNonce: Bytes;
  /** The taker's spend commitment stored in the swap. */
  takerSpendPub: Bytes;
}

/**
 * Whether `seed` is the seed that opened these swaps: for each, the taker's spend commitment
 * re-derived from the swap's nonce equals the one stored on chain. With no swap there is
 * nothing to prove (`checked` = 0, `ok` = true): use the two-signature check instead.
 */
export function walletSeedMatchesSwaps(seed: Bytes, chain: ChainName, swaps: readonly KnownSwap[]): { ok: boolean; checked: number; mismatched: number } {
  let mismatched = 0;
  for (const s of swaps) {
    let same = false;
    try {
      same = bytesEqual(takerSwapKeys(seed, chain, s.swapNonce).spendPub, s.takerSpendPub);
    } catch {
      same = false;
    }
    if (!same) mismatched++;
  }
  return { ok: mismatched === 0, checked: swaps.length, mismatched };
}

/** Asks the wallet for one signature of the wallet-key message: `signMessage(bytes)` on Solana, `eth_signTypedData_v4` on Ethereum. */
export type WalletKeySigner = () => Promise<Bytes>;

export interface UnlockedWalletSeed {
  seed: Bytes;
  /** How the seed was proved: two equal signatures (a wallet with no swaps), or the commitments of its swaps. */
  provedBy: 'two-signatures' | 'swap-commitments';
  /** Swaps whose commitment the seed re-derived. */
  swapsChecked: number;
}

/**
 * Unlock the wallet-derived seed (SPEC 11.3 rules).
 *
 * `swaps` are the wallet's swaps found on chain (`listSwapsByTaker`, or the Ethereum `Locked`
 * events of the taker). With none, the wallet signs **twice** and different bytes refuse the
 * mode for that wallet (`NonDeterministicSigner`): such a signer would lose the key. With some,
 * it signs **once** and the seed must re-derive every stored commitment; a mismatch refuses the
 * mode (`WalletSeedMismatch`) and the user needs the recovery file.
 *
 * The page shows `WALLET_KEY_WARNINGS` with a checkbox before the first call, and
 * `walletKeySiteProblem` when its host is not the canonical site.
 */
export async function unlockWalletSeed(c: WalletKeyContext, sign: WalletKeySigner, swaps: readonly KnownSwap[]): Promise<UnlockedWalletSeed> {
  const first = await sign();
  const seed = await deriveWalletSeed(c, first);
  if (swaps.length === 0) {
    const second = await sign();
    // Ethereum: one signature in two spellings is still one signature; compare the canonical form.
    const canon = (sig: Bytes): Bytes => (c.chain === 'ethereum' ? normalizeEthSignature(sig) : sig);
    let equal = false;
    try {
      equal = bytesEqual(canon(first), canon(second));
    } catch {
      equal = false;
    }
    if (!equal) throw new SdkError('NonDeterministicSigner', 'this wallet signs the same message differently each time: the wallet key cannot be used with it');
    return { seed, provedBy: 'two-signatures', swapsChecked: 0 };
  }
  const m = walletSeedMatchesSwaps(seed, c.chain, swaps);
  if (!m.ok) throw new SdkError('WalletSeedMismatch', `this wallet's signature does not reproduce the keys of ${m.mismatched} of its ${m.checked} swaps: use the recovery file`);
  return { seed, provedBy: 'swap-commitments', swapsChecked: m.checked };
}

/**
 * "Export recovery file" in this mode: the ordinary format, holding the derived seed. Because
 * the seed is per chain and wallet, the file lists that one wallet and covers that chain's
 * swaps of it only.
 */
export function walletKeyRecoveryFile(c: WalletKeyContext, seed: Bytes, deployment: { programId: string; contract: string }, createdAt?: Date): RecoveryFilePlain {
  const wallet = c.chain === 'ethereum' ? c.wallet.toLowerCase() : c.wallet;
  return createRecoveryFile({ seed, wallets: { [c.chain]: [wallet] }, programId: deployment.programId, contract: deployment.contract, ...(createdAt ? { createdAt } : {}) });
}

/**
 * The message names the canonical site, not the page's origin, so a self-hosted copy derives
 * the same keys. A page whose host is neither that site nor loopback must say so before asking
 * for the signature: returns the text to show, or `null`.
 */
export function walletKeySiteProblem(host: string, site: string = WALLET_KEY_SITE): string | null {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  if (h === site.toLowerCase() || h === 'localhost' || h === '[::1]' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h)) return null;
  return `This page is served from ${host}, not from ${site}. The message you are about to sign names ${site}; only continue if you run this copy yourself.`;
}
