/**
 * Plain words for the SDK's bounded-signing refusals (its DEVIATIONS X3, X4). Each of these is
 * raised before anything is signed: nothing was sent.
 */
const gwei = (wei: bigint): string => `${(Number(wei / 10_000_000n) / 100).toFixed(2)} gwei`;

export function signingRefusalText(e: unknown): string | null {
  const code = (e as { code?: string })?.code ?? '';
  const msg = e instanceof Error ? e.message : String(e);
  const nums = (msg.match(/\d+/g) ?? []).map((n) => BigInt(n));
  switch (code) {
    case 'FeeTooHigh': {
      const [asked, cap] = [nums.at(-2), nums.at(-1)];
      return `Network fee above your limit: the network asks ${asked !== undefined ? gwei(asked) : 'more'} per unit of gas and this page signs at most ${cap !== undefined ? gwei(cap) : 'its cap'}. Nothing was signed or sent. The page tries again when the fee falls; while a swap is at risk, keep the tab open, because a refund that cannot be sent in time can cost you your funds.`;
    }
    case 'GasLimitTooHigh':
      return `The Ethereum RPC says this transaction needs far more gas than it should (${msg.replace(/^GasLimitTooHigh:\s*/, '')}). An endpoint that inflates the estimate could drain the fee budget, so nothing was signed. Check the RPC in Settings.`;
    case 'WrongChain':
      return `The Ethereum RPC is on a different chain than this site is for (${msg.replace(/^WrongChain:\s*/, '')}). Nothing was signed. Point Settings at an RPC for the right chain.`;
    case 'ChainIdNotPinned':
      return 'This page has no chain id pinned for Ethereum, so it will not sign. Nothing was sent.';
    case 'ComputeLimitTooHigh':
    case 'PriorityFeeTooHigh':
    case 'NoSimulation':
      return `The Solana RPC answered with a fee this page will not sign for (${msg}). Nothing was signed or sent. Check the RPC in Settings.`;
    default:
      return null;
  }
}

/** Re-throw a bounded-signing refusal in plain words; anything else passes through unchanged. */
export function plainSigningError(e: unknown): unknown {
  const text = signingRefusalText(e);
  return text ? Object.assign(new Error(text), { code: (e as { code?: string }).code }) : e;
}

/** Thrown when a transaction's blockhash expired without it landing: it can never land now, so sending again is safe. */
export class TransactionExpired extends Error {
  readonly code = 'TransactionExpired';
  constructor() {
    super('The transaction did not land before its blockhash expired, so it never will. Nothing changed on-chain; it is safe to send it again.');
  }
}

export const wrongWalletChain = (walletChain: number, siteChain: number): string => `Your wallet is on chain ${walletChain}; this site is for chain ${siteChain}. Switch networks in the wallet. Nothing was signed or sent.`;
