/**
 * What the maker's own transactions cost per swap, with the figures measured after Amendment 1
 * (`solana/DEVIATIONS.md` "Compute units"; `packages/sdk/DEVIATIONS.md` G1). The fee-wallet
 * runway and the daily-cost figure the console reads are built from these.
 *
 * Solana: a transaction pays 5,000 lamports plus the priority fee on its compute-unit LIMIT,
 * which the SDK sets to the simulated use × 1.2. Ethereum: gas × the gas price; every figure is
 * an upper bound (the dearest measured variant).
 */
import { ETH_SESSION_GAS, ETH_SESSION_GAS_PER_CALL, ETH_WATCHER_GAS, SOLANA_OPEN_CU_LIMIT, SOLANA_OPEN_CU_LIMIT_USDC_APPROVAL } from '@xmrswap/sdk';
import type { RawConfig } from '../config/schema.js';

type Pair = { sol: number; usdc: number };
/** Measured compute units of the calls the operator sends (ceilings of the measured ranges). */
export const SOLANA_CU: Record<string, Pair> = {
  approve: { sol: 24_000, usdc: 24_000 },
  fund: { sol: 27_000, usdc: 31_000 },
  reject: { sol: 24_000, usdc: 24_000 },
  post_notice: { sol: 16_000, usdc: 16_000 },
  set_ready: { sol: 16_000, usdc: 16_000 },
  freeze: { sol: 16_000, usdc: 16_000 },
  abort: { sol: 16_000, usdc: 16_000 },
  claim: { sol: 27_000, usdc: 48_000 },
  refund: { sol: 24_000, usdc: 35_000 },
  withhold: { sol: 16_500, usdc: 16_500 },
  publish_evidence: { sol: 16_500, usdc: 16_500 },
  release_deposit: { sol: 23_000, usdc: 38_000 },
  close_swap: { sol: 18_000, usdc: 23_000 },
  refill_keys: { sol: 74_000, usdc: 74_000 },
  refresh_offers: { sol: 20_100, usdc: 20_100 },
};
/** What a taker's open needs as its compute-unit limit since Amendment 1 (60,000 was enough before). */
export const TAKER_OPEN_CU = { lock_or_take: SOLANA_OPEN_CU_LIMIT, usdc_with_approval: SOLANA_OPEN_CU_LIMIT_USDC_APPROVAL } as const;
const CU_MARGIN = 1.2;

/** Lamports one operator transaction of this call costs at the configured priority fee. */
export function solanaCallFee(raw: RawConfig, call: string, usdc: boolean): bigint {
  const cu = SOLANA_CU[call]?.[usdc ? 'usdc' : 'sol'] ?? 30_000;
  return 5_000n + BigInt(Math.ceil((raw.solana.priority_fee_microlamports * cu * CU_MARGIN) / 1_000_000));
}

/** The operator's calls of an ordinary swap: sell-XMR (A) and buy-XMR (B), happy path; `window` adds the approval. */
const SOL_CALLS = { A: ['post_notice', 'claim', 'close_swap'], A_window: ['approve', 'post_notice', 'claim', 'close_swap'], B: ['fund', 'set_ready', 'close_swap'] } as const;
/** Ethereum gas: measured where the SDK measured it, else the dearest measured call plus 25%. */
export const ETH_MAKER_GAS = {
  approve: ETH_SESSION_GAS_PER_CALL,
  postNotice: ETH_SESSION_GAS.postNotice,
  claim: ETH_SESSION_GAS.claim,
  fund: 198_400n,
  setReady: ETH_SESSION_GAS.setReady,
  refund: ETH_SESSION_GAS.refund,
  freeze: ETH_WATCHER_GAS.freeze,
  pushOwed: ETH_WATCHER_GAS.pushOwed,
} as const;
const ETH_SWAP_GAS = { A: ETH_MAKER_GAS.approve + ETH_MAKER_GAS.postNotice + ETH_MAKER_GAS.claim, B: ETH_MAKER_GAS.fund + ETH_MAKER_GAS.setReady } as const;

export interface SwapCosts {
  solana: Record<'sol' | 'usdc_sol', { sell_xmr: { compute_units: number; lamports: string }; sell_xmr_window: { compute_units: number; lamports: string }; buy_xmr: { compute_units: number; lamports: string } }>;
  ethereum: { sell_xmr_gas: string; buy_xmr_gas: string; freeze_gas: string; push_owed_gas: string; max_fee_gwei: number | null; sell_xmr_wei: string | null; buy_xmr_wei: string | null };
  taker_open_compute_units: typeof TAKER_OPEN_CU;
}

/** Per-swap fee figures at the configured priority fee and gas cap (`swap_cost` in the offers, fees and validation answers). */
export function swapCosts(raw: RawConfig): SwapCosts {
  const sol = (usdc: boolean, calls: readonly string[]) => ({ compute_units: calls.reduce((a, c) => a + SOLANA_CU[c]![usdc ? 'usdc' : 'sol'], 0), lamports: calls.reduce((a, c) => a + solanaCallFee(raw, c, usdc), 0n).toString() });
  const market = (usdc: boolean) => ({ sell_xmr: sol(usdc, SOL_CALLS.A), sell_xmr_window: sol(usdc, SOL_CALLS.A_window), buy_xmr: sol(usdc, SOL_CALLS.B) });
  const gwei = raw.ethereum.max_fee_gwei ?? null;
  const wei = (gas: bigint): string | null => (gwei === null ? null : (gas * BigInt(Math.round(gwei * 1e9))).toString());
  return {
    solana: { sol: market(false), usdc_sol: market(true) },
    ethereum: { sell_xmr_gas: ETH_SWAP_GAS.A.toString(), buy_xmr_gas: ETH_SWAP_GAS.B.toString(), freeze_gas: ETH_MAKER_GAS.freeze.toString(), push_owed_gas: ETH_MAKER_GAS.pushOwed.toString(), max_fee_gwei: gwei, sell_xmr_wei: wei(ETH_SWAP_GAS.A), buy_xmr_wei: wei(ETH_SWAP_GAS.B) },
    taker_open_compute_units: TAKER_OPEN_CU,
  };
}
/** The dearest ordinary Ethereum swap, in gas (the fee-wallet runway counts in these). */
export const ETH_SWAP_GAS_MAX = ETH_SWAP_GAS.A > ETH_SWAP_GAS.B ? ETH_SWAP_GAS.A : ETH_SWAP_GAS.B;
