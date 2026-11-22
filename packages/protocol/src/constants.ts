/**
 * Protocol constants (SPEC 3.1, 3.3, 3.7, 4.1, 2.x). Mirrors `crates/swap-core` and the two
 * contracts; `interfaces/vectors/deadlines.json` carries the same values and the tests compare
 * them. Changing one is a code change in every implementation plus regenerated vectors.
 */
import { DEV_PROGRAM_ID } from './generated/solana.js';

export type ChainName = 'solana' | 'ethereum';
export type Market = 'sol' | 'usdc_sol' | 'eth' | 'usdc_eth';
export const MARKETS: readonly Market[] = ['sol', 'usdc_sol', 'eth', 'usdc_eth'];
/** Which chain enforces a market's swaps. */
export const MARKET_CHAIN: Readonly<Record<Market, ChainName>> = { sol: 'solana', usdc_sol: 'solana', eth: 'ethereum', usdc_eth: 'ethereum' };
/** Decimals of each market's asset. */
export const MARKET_DECIMALS: Readonly<Record<Market, number>> = { sol: 9, usdc_sol: 6, eth: 18, usdc_eth: 6 };
/** Solana asset ids: `0` = SOL, `1` = USDC. */
export const SOLANA_ASSET = { sol: 0, usdc: 1 } as const;

/** Direction A: the taker pays the chain asset and receives XMR. Direction B: the taker pays XMR. */
export const DIRECTION = { A: 0, B: 1 } as const;
export type Direction = (typeof DIRECTION)[keyof typeof DIRECTION];

export const PICONERO_PER_XMR = 1_000_000_000_000n;
export const BPS_DENOMINATOR = 10_000n;
export const DAY_SECS = 86_400;
export const MIN_APPROVAL_SECS = 30;

/** Every constant of SPEC 3.1 for one chain, plus the three behavioural switches. Seconds are numbers. */
export interface ChainConsts {
  readonly feeBps: number;
  readonly maxDepositBps: number;
  readonly holdSecs: number;
  readonly splitSecs: number;
  /** `W_x`: after the final deadline. */
  readonly expirySecs: number;
  /** `B`: per-confirmation allowance in the refund cutoff. */
  readonly blockAllowanceSecs: number;
  readonly cutMarginSecs: number;
  /** `M`: broadcast margin (client rule 2). */
  readonly marginSecs: number;
  /** `F`: finality allowance. */
  readonly finalitySecs: number;
  readonly minNoticeSecs: number;
  readonly maxNoticeSecs: number;
  readonly minClaimDelaySecs: number;
  readonly maxApprovalSecs: number;
  readonly maxFinalSecs: number;
  readonly readyMinSecsPerConf: number;
  /** Solana only; 0 = not applicable. */
  readonly closeGraceSecs: number;
  readonly linkDelaySecs: number;
  readonly maxOpenPending: number;
  /** Every swap starts PENDING regardless of mode. */
  readonly explicitApprove: boolean;
  /** Anyone may call `claim` and `refund`. */
  readonly openSecretCalls: boolean;
  /** A lapsed take outside window mode is the fault `missed_funds`. */
  readonly lapseIsFault: boolean;
}

export const SOLANA_CONSTS: ChainConsts = {
  feeBps: 5,
  maxDepositBps: 500,
  holdSecs: 1_800,
  splitSecs: 5_184_000,
  expirySecs: 2_592_000,
  blockAllowanceSecs: 180,
  cutMarginSecs: 900,
  marginSecs: 300,
  finalitySecs: 15,
  minNoticeSecs: 300,
  maxNoticeSecs: 3_600,
  minClaimDelaySecs: 3_600,
  maxApprovalSecs: 3_600,
  maxFinalSecs: 2_592_000,
  readyMinSecsPerConf: 60,
  closeGraceSecs: 2_592_000,
  linkDelaySecs: 604_800,
  maxOpenPending: 64,
  explicitApprove: false,
  openSecretCalls: false,
  lapseIsFault: true,
};

export const ETHEREUM_CONSTS: ChainConsts = {
  feeBps: 5,
  maxDepositBps: 500,
  holdSecs: 1_800,
  splitSecs: 5_184_000,
  expirySecs: 2_592_000,
  blockAllowanceSecs: 180,
  cutMarginSecs: 900,
  marginSecs: 1_800,
  finalitySecs: 1_200,
  minNoticeSecs: 1_500,
  maxNoticeSecs: 3_600,
  minClaimDelaySecs: 7_200,
  maxApprovalSecs: 3_600,
  maxFinalSecs: 2_592_000,
  readyMinSecsPerConf: 60,
  closeGraceSecs: 0,
  linkDelaySecs: 604_800,
  maxOpenPending: 64,
  explicitApprove: true,
  openSecretCalls: true,
  lapseIsFault: false,
};

export const CHAIN_CONSTS: Readonly<Record<ChainName, ChainConsts>> = { solana: SOLANA_CONSTS, ethereum: ETHEREUM_CONSTS };

/** Swap states (SPEC 3.3). 0 = no such swap. */
export const SWAP_STATE = {
  NONE: 0,
  PENDING: 1,
  ACTIVE: 2,
  NOTICED: 3,
  READY: 4,
  ABORTED_FREE: 5,
  ABORTED_HOLD: 6,
  HOLD: 7,
  WITHHELD: 8,
  DONE: 9,
} as const;
export type SwapStateName = keyof typeof SWAP_STATE;
export type SwapStateCode = (typeof SWAP_STATE)[SwapStateName];
export const SWAP_STATE_NAMES: readonly SwapStateName[] = ['NONE', 'PENDING', 'ACTIVE', 'NOTICED', 'READY', 'ABORTED_FREE', 'ABORTED_HOLD', 'HOLD', 'WITHHELD', 'DONE'];

/** Offer and quote modes, and the effective mode stored in a swap. */
export const APPROVAL_MODE = { AUTO: 0, WINDOW: 1, ADVANCE: 2, QUOTE: 3 } as const;

/** Bits of `Swap.flags`. */
export const SWAP_FLAG = {
  /** A lock notice is on record. */
  NOTICE: 1 << 0,
  /** Evidence was published. */
  EVIDENCE: 1 << 1,
  /** A spend share was revealed. */
  REVEALED: 1 << 2,
  /** The revealer was the locker (the swap ended in a refund). */
  REVEALER_LOCKER: 1 << 3,
  /** Direction B: the notice arrived at or after `T_note`. */
  LATE_NOTICE: 1 << 4,
} as const;

/** Values of `deposit_state`. */
export const DEPOSIT_STATE = { NONE: 0, HELD: 1, WITHHELD: 2, RETURNED: 3, RELEASED: 4, SPLIT: 5 } as const;

/** `maker.paused` bits on Solana. */
export const PAUSE_BIT = { OWNER: 1, OPERATOR: 2 } as const;

/** Counter names by id (SPEC 3.7). The id is also the `outcome` code. Ids 33 to 39 are reserved. */
export const COUNTER_NAMES = [
  'locks',
  'takes',
  'approvals',
  'rejections',
  'approval_timeouts',
  'pending_cancels',
  'notices',
  'readies',
  'completed',
  'claims_without_ready',
  'claims_after_final',
  'missed_notices',
  'missed_claims',
  'missed_funds',
  'aborts_pre_notice',
  'aborts_early',
  'aborts_late',
  'backouts_pre_notice',
  'backouts_post_notice',
  'taker_claims_without_ready',
  'taker_cancels_approved',
  'taker_refunds_noticed',
  'refunds_after_abort',
  'taker_no_notice',
  'refunds_unconfirmed',
  'taker_missed_claims',
  'taker_aborts',
  'expired_refunds',
  'deposits_returned',
  'withholds',
  'releases',
  'splits',
  'rejections_no_fault',
] as const;
export type CounterName = (typeof COUNTER_NAMES)[number];
export const COUNTER: Readonly<Record<CounterName, number>> = Object.fromEntries(COUNTER_NAMES.map((n, i) => [n, i])) as Record<CounterName, number>;
export const COUNTER_SLOTS = 40;
/** `outcome` while a swap is open, and the counter byte of an event that moves no counter. */
export const COUNTER_NONE = 0xff;
/** Provable maker faults. */
export const FAULT_COUNTERS: readonly CounterName[] = ['missed_notices', 'missed_claims', 'missed_funds'];

/** `reject` reasons (SPEC 3.7). Reasons 1 and 2 count as `rejections_no_fault`. */
export const REJECT_REASON = { MAKER_CHOICE: 0, UNUSABLE_INPUT: 1, LEAF_CONSUMED: 2 } as const;

/** `withdraw_owed(who)` on Solana, and `who` in `PayoutParked`. */
export const OWED = { TAKER: 0, MAKER: 1, TREASURY: 2 } as const;

/** Maker contact kinds (SPEC 4.2). */
export const CONTACT_KIND = { WEBSITE: 0, EMAIL: 1, MATRIX: 2, DISCORD: 3, TELEGRAM: 4, BLOB_ENDPOINT: 5, OTHER: 255 } as const;

// ------------------------------------------------------------------ deployment (SPEC 4.9, 5.1, 8.8)

/**
 * Where a release of the protocol lives. One source for the relay, the daemon, both UIs and the
 * self-hosting bundle; the UIs show both values so users can check them against the published ones.
 */
export interface Deployment {
  /** Solana program id, base58. */
  readonly programId: string;
  /** Ethereum contract (the proxy) address, `0x`-prefixed, or `null` while none is deployed. */
  readonly contract: `0x${string}` | null;
  /** EVM chain id the contract lives on, or `null`. */
  readonly chainId: number | null;
}

/**
 * The Solana program id this release is pinned to. Until the project owner deploys, it is the
 * development id of `interfaces/solana/program-id.txt`; a release replaces it.
 */
export const PROGRAM_ID: string = DEV_PROGRAM_ID;

/**
 * The Ethereum contract address of this release: the per-release slot. `null` until the project
 * owner deploys (nothing in this repository deploys to a live network); tests pass the address
 * of their own anvil deployment explicitly.
 */
export const CONTRACT_ADDRESS: `0x${string}` | null = null;
/** Chain id of `CONTRACT_ADDRESS`, or `null`. */
export const CONTRACT_CHAIN_ID: number | null = null;

/** The pinned deployment of this release. */
export const DEPLOYMENT: Deployment = { programId: PROGRAM_ID, contract: CONTRACT_ADDRESS, chainId: CONTRACT_CHAIN_ID };

// ------------------------------------------------------------------ Solana layout (SPEC 4.1, 4.2)

/** PDA seeds. */
export const SEED = {
  config: 'config',
  treasury: 'treasury',
  treasuryVault: 'treasury_vault',
  maker: 'maker',
  offer: 'offer',
  ethBoard: 'eth_board',
  quote: 'quote',
  swap: 'swap',
  vault: 'vault',
} as const;

/** Account sizes in bytes, discriminator included. */
export const ACCOUNT_SIZE = { Config: 256, Treasury: 16, Maker: 1_280, Offer: 768, EthBoard: 1_408, Quote: 192, Swap: 736 } as const;

/** `memcmp` offsets clients filter on. */
export const OFFSET = {
  discriminator: 0,
  maker: { owner: 8, operator: 40, payout: 72 },
  offer: { maker: 8, asset: 40, direction: 41, enabled: 42, mode: 43 },
  quote: { maker: 8, taker: 40 },
  swap: { taker: 8, maker: 40, state: 72, direction: 73, asset: 74 },
} as const;

/** Base58 of the `Maker` and `Swap` account discriminators, for `memcmp.bytes`. */
export const DISCRIMINATOR_BASE58 = { Maker: '6MSKcZArUDQ', Swap: '9zzgj4NEBqr' } as const;

export const POOL_SLOTS = 16;
export const ETH_BOARD_SLOTS = 4;
export const MAX_KEY_SLOTS_PER_REFILL = 8;
export const MAX_ONION_LEN = 62;
export const MAX_CONTACTS = 6;
export const MAX_CONTACT_LEN = 96;
/** A taker-bound Solana quote expires at most this long after it is posted. */
export const MAX_QUOTE_SECS = 120;
/** SOL burned in `split_mode = 1` goes here. */
export const INCINERATOR = '1nc1nerator11111111111111111111111111111111';
/** Advance-approval wildcard for `asset` and `direction` on Solana. */
export const SOL_APPROVAL_ANY = 0xff;
export const SOL_APPROVAL_LEN = 190;
/** SDK default session-key budget above the rent minimum (about 400 base fees). */
export const SESSION_BUDGET_LAMPORTS = 2_000_000n;

// ------------------------------------------------------------------ Ethereum (SPEC 2.10, 5)

export const EIP712_NAME = 'XmrAtomicSwap';
export const EIP712_VERSION = '1';
/** `Approval.token` wildcard. */
export const ETH_ANY_TOKEN = '0xFFfFfFffFFfffFFfFFfFFFFFffFFFffffFfFFFfF';
/** `Approval.direction` wildcard. */
export const ETH_ANY_DIRECTION = 255;
/** ETH as a token address. */
export const ETH_NATIVE = '0x0000000000000000000000000000000000000000';
export const COMPACT_QUOTE_LEN = 251;
export const COMPACT_QUOTE_SIGNED_LEN = 316;
/** The UI refuses to submit an Ethereum quote with less than this left. */
export const ETH_QUOTE_MIN_LEFT_SECS = 36;
export const MERKLE_MIN_LEAVES = 2;
export const MERKLE_MAX_LEAVES = 256;
export const MERKLE_DEFAULT_LEAVES = 64;

// ------------------------------------------------------------------ messages and proofs (SPEC 2.6, 2.8, 6)

export const ENVELOPE_MAX_ONCHAIN = 900;
export const ENVELOPE_MAX_TOR = 16_384;
export const NOTICE_CIPHERTEXT_LEN = 104;
export const DLEQ_MAX_BLOB = 60_000;
export const DLEQ_BLOB_LEN = 56_679;
/** How long the maker endpoint keeps replies and unreferenced proofs. */
export const REPLY_RETENTION_DAYS = 30;
export const DLEQ_RETENTION_MINUTES = 15;
export const INBOX_TEXT_MAX_CHARS = 2_000;

// ------------------------------------------------------------------ Monero (SPEC 2.5, 2.11, 8.6)

export type MoneroNetwork = 'mainnet' | 'stagenet' | 'testnet' | 'regtest';
/** Standard-address prefix byte. Regtest uses the mainnet prefix. */
export const MONERO_ADDRESS_PREFIX: Readonly<Record<MoneroNetwork, number>> = { mainnet: 18, stagenet: 24, testnet: 53, regtest: 18 };
/** An output is spendable once it is this deep, whatever the swap's depth tier. */
export const MONERO_LOCK_WINDOW = 10;
/** `max_fee` of a sweep is `max(SWEEP_FEE_FLOOR, amount × SWEEP_FEE_CAP_BPS / 10,000)`. */
export const SWEEP_FEE_FLOOR = 2_000_000_000n;
export const SWEEP_FEE_CAP_BPS = 50n;
export const sweepMaxFee = (amount: bigint): bigint => {
  const capped = (amount * SWEEP_FEE_CAP_BPS) / BPS_DENOMINATOR;
  return capped > SWEEP_FEE_FLOOR ? capped : SWEEP_FEE_FLOOR;
};
/** Depth the taker requires for the total in flight: 2 below 1 XMR, 10 below 50 XMR, 25 from 50 XMR. */
export const TAKER_DEPTH_TIERS: readonly { readonly aboveXmr: bigint; readonly depth: number }[] = [
  { aboveXmr: 0n, depth: 2 },
  { aboveXmr: 1n * PICONERO_PER_XMR, depth: 10 },
  { aboveXmr: 50n * PICONERO_PER_XMR, depth: 25 },
];
export const takerDepthFor = (totalInFlight: bigint): number =>
  TAKER_DEPTH_TIERS.reduce((depth, tier) => (totalInFlight >= tier.aboveXmr ? tier.depth : depth), TAKER_DEPTH_TIERS[0]!.depth);

/** The page refuses to show a direction-B address with less than this left before `T_note`. */
export const B_ADDRESS_MIN_LEFT_SECS: Readonly<Record<ChainName, number>> = { solana: 180, ethereum: 600 };
/** Local clock versus chain time: warn above this. */
export const CLOCK_SKEW_WARN_SECS = 30;
