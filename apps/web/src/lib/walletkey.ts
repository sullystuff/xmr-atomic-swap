/**
 * The optional wallet-derived key (SPEC 11.3), off by default. The swap seed is derived from one
 * wallet signature over a fixed message, so the wallet itself is the backup. The signature is
 * passed to the core and dropped: it is never stored and never sent anywhere.
 */
import { WALLET_KEY_WARNINGS } from '@xmrswap/protocol';
import { walletKeySiteProblem } from '@xmrswap/sdk';

/** The three warnings shown, with a checkbox, before the first signature. The third names the configured site. */
export function walletKeyWarnings(site: string): string[] {
  return [WALLET_KEY_WARNINGS[0]!, WALLET_KEY_WARNINGS[1]!, `Only sign this message on ${site}.`];
}

export type WalletKeyUnavailable = 'no-site' | 'no-wallet' | 'no-sign-message';
export const UNAVAILABLE_TEXT: Readonly<Record<WalletKeyUnavailable, string>> = {
  'no-site': 'Not available in this release: the project has not yet fixed the site name that goes into the signed message. Without it a key made now could not be made again later, so the page does not offer the option. Use a recovery file.',
  'no-wallet': 'Connect the wallet whose signature should unlock your swap keys.',
  'no-sign-message': 'This wallet cannot sign a plain message (the Wallet Standard feature solana:signMessage is missing), so it cannot be used as a key. Use a recovery file, or another wallet.',
};

/** Why the mode cannot be offered, or `null`. `site` is the release's `WALLET_KEY_SITE` from the served config; empty = not chosen yet. */
export function walletKeyUnavailable(site: string, wallet: { signMessage?: unknown } | null): WalletKeyUnavailable | null {
  if (!site.trim()) return 'no-site';
  if (!wallet) return 'no-wallet';
  if (typeof wallet.signMessage !== 'function') return 'no-sign-message';
  return null;
}

/** What to say before asking for the signature on a page that is neither the canonical site nor loopback. */
export const siteProblem = (host: string, site: string): string | null => walletKeySiteProblem(host, site);

/** Plain words for the ways unlocking can be refused. */
export function unlockErrorText(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'NonDeterministicSigner') return 'This wallet gave two different signatures for the same message. A key made from it could never be made again, so your swaps would be lost: the wallet cannot be used this way. Use a recovery file.';
  if (code === 'WalletSeedMismatch') return 'This signature does not produce the keys of the swaps this wallet already has on-chain. They were opened with a recovery file, or with a different wallet or site name: load the recovery file to resume them. Nothing was changed.';
  if (code === 'WalletSignatureInvalid') return 'The wallet returned something that is not its signature over the message shown. Nothing was derived from it.';
  return e instanceof Error ? e.message : String(e);
}
