/**
 * Seed data for the mock daemon. Every address, key and hash here is synthetic filler built
 * from a label; none is a real key and none exists on any network.
 */
import { base58Encode } from '@xmrswap/protocol';
import type {
  AdvanceApprovalRecord,
  Alert,
  DepositView,
  EncKeyView,
  InboxItem,
  InventoryResponse,
  PendingApproval,
  RefillView,
  RegistrationResponse,
  SwapDeadlines,
  SwapDetail,
} from '@xmrswap/protocol/daemon-api';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function prng(label: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < label.length; i++) h = Math.imul(h ^ label.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}
/** A Solana-shaped placeholder address: 32 filler bytes in base58. */
export function fakeSol(label: string): string {
  const r = prng(`sol:${label}`);
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = Math.floor(r() * 256);
  bytes[0] = 16 + (bytes[0] as number) % 200; // never a leading zero byte, so always 43 or 44 characters
  return base58Encode(bytes);
}
export function fakeHex(label: string, bytes: number): string {
  const r = prng(`hex:${label}`);
  let s = '';
  for (let i = 0; i < bytes * 2; i++) s += Math.floor(r() * 16).toString(16);
  return s;
}
export const fakeEth = (label: string): string => `0x${fakeHex(`eth:${label}`, 20)}`;
export const fakeXmrAddr = (label: string): string => {
  const r = prng(`xmr:${label}`);
  let s = '4';
  for (let i = 0; i < 94; i++) s += B58[Math.floor(r() * B58.length)];
  return s;
};

export const XMR = 1_000_000_000_000n;
export const xmr = (n: number): string => BigInt(Math.round(n * 1e6)) * 1_000_000n + '';
export const usdc = (n: number): string => BigInt(Math.round(n * 1e6)).toString();
export const sol = (n: number): string => BigInt(Math.round(n * 1e9)).toString();
export const eth = (n: number): string => (BigInt(Math.round(n * 1e9)) * 1_000_000_000n).toString();

/** Reference prices the mock quotes from, in USD. */
export const REFERENCE_USD = { xmr: 412.35, sol: 187.42, eth: 3_420.1 } as const;

/**
 * The configuration the mock starts with: DESIGN's two example files (pricing, markets,
 * liquidity, guardrails; rebalancing) plus a buy-side offer, an approval-window offer and the
 * daemon sections, switched to live mode so the monitoring pages have something to show.
 */
export const DEFAULT_TOML = `[daemon]
mode = "live"

[pricing]
refresh_seconds = 15
max_age_seconds = 60
cross_check = "coinmarketcap"
max_disagreement_pct = 1.0
on_failure = "pause"

[pricing.sources.coingecko]
api_key_env = "COINGECKO_KEY"

[pricing.sources.coinmarketcap]
api_key_env = "CMC_KEY"

[pricing.sources.wxmr_pool]
token = "<wXMR token address>"
pool = "<pool address>"
min_liquidity_usd = 250000
average_seconds = 300

[markets.usdc_sol.sell_xmr]
enabled = true
source = "coingecko"
fallbacks = ["coinmarketcap"]
deviation_pct = 1.5
size_tiers = [{ above_xmr = 50, extra_pct = 0.5 }]
min_xmr = 0.1
max_xmr = 200
offer_valid_seconds = 60
deposit_pct = 2.0
withhold_policy = "price_moved"

[markets.usdc_sol.buy_xmr]
enabled = true
source = "coingecko"
fallbacks = ["coinmarketcap"]
deviation_pct = 1.0
max_xmr = 50

[markets.sol.sell_xmr]
enabled = true
source = "wxmr_pool"
fallbacks = ["coingecko"]
deviation_pct = 2.0
approval_mode = "window"
approval_window_seconds = 60

[markets.usdc_eth.sell_xmr]
enabled = true
source = "coingecko"
deviation_pct = 2.0

[markets.eth.sell_xmr]
enabled = false

[liquidity]
xmr_reserve = 50
output_ladder = [{ size_xmr = 5, count = 20 }, { size_xmr = 50, count = 6 }]
max_in_flight_xmr = 400

[guardrails]
volatility_pause = { move_pct = 3.0, window_seconds = 600 }
price_band_usd = { min = 300, max = 900 }

[offers]
update_interval_seconds = 15

[solana]
priority_fee_microlamports = 0

[rotation]
interval_hours = 168
grace_hours = 24

[alerts]
fee_runway_days = 7

[rebalance]
mode = "approve"
max_cost_pct = 1.5
max_in_transit_usd = 50000
test_transfer_usd = 50

[rebalance.levels.xmr]
low = 150
target = 400
high = 700

[rebalance.levels.usdc_sol]
high = 120000

[rebalance.routing]
choose = "best_quote"
priority = ["wxmr_bridge", "exchange", "changenow", "fixedfloat", "stealthex", "houdiniswap"]
max_per_tx_usd = 20000
max_per_day_usd = 150000

[rebalance.venues.wxmr_bridge]
enabled = true
max_cost_pct = 1.0
max_piece_pct_of_pool = 2.0
max_wxmr_held = 5
redeem_immediately = true
require_heartbeat = true
reserve_proof_check_above_xmr = 50
stalled_redeem_minutes = 60

[rebalance.venues.exchange]
enabled = true
name = "<exchange>"
api_key_env = "EXCHANGE_KEY"
withdraw_address_allowlist = true

[rebalance.venues.changenow]
enabled = true
rate = "fixed"
api_key_env = "CHANGENOW_KEY"

[rebalance.venues.fixedfloat]
enabled = true
rate = "float"
api_key_env = "FF_KEY"

[rebalance.venues.stealthex]
enabled = false

[rebalance.venues.houdiniswap]
enabled = false
`;

export const ADDR = {
  solOwner: fakeSol('owner'),
  solOperator: fakeSol('operator'),
  solPayout: fakeSol('payout'),
  solMaker: fakeSol('maker-pda'),
  ethOwner: fakeEth('owner'),
  ethOperator: fakeEth('operator'),
  ethPayout: fakeEth('payout'),
  program: fakeSol('program'),
  contract: fakeEth('contract'),
  upgradeAuthoritySol: fakeSol('upgrade-authority'),
  upgradeAuthorityEth: fakeEth('upgrade-authority'),
  inventory: fakeXmrAddr('inventory'),
} as const;

export function seedRegistration(): RegistrationResponse {
  return {
    solana: {
      registered: true,
      maker: ADDR.solMaker,
      owner: ADDR.solOwner,
      operator: ADDR.solOperator,
      payout: ADDR.solPayout,
      payout_usdc_account: true,
      enc_key_version: 7,
      onion: null,
      contacts: [
        { kind: 2, value: '#maker-desk:example.org' },
        { kind: 1, value: 'desk@example.org' },
        { kind: 5, value: 'https://blobs.example.org/xs' },
      ],
      inbox_policy: 'open',
      link: { current: ADDR.ethOwner, pending: null, pending_effective_at: null, mutual: true },
    },
    ethereum: {
      registered: true,
      maker: ADDR.ethOwner,
      operator: ADDR.ethOperator,
      payout: ADDR.ethPayout,
      quote_epoch: 3,
      approval_epoch: 2,
      link: { current: ADDR.solOwner, pending: null, pending_effective_at: null, mutual: true },
    },
    blob_endpoint: true,
  };
}

const NO_DEADLINES: Omit<SwapDeadlines, 't_lock' | 't_final' | 't_exp'> = {
  t_pending_deadline: null,
  t_active: null,
  t_note_deadline: null,
  t_notice: null,
  t_cut: null,
  t_claim_open: null,
  t_ready: null,
  t_claim_deadline: null,
  t_refund: null,
  t_hold: null,
  t_split: null,
  t_settled: null,
};
const deadlines = (tLock: number, more: Partial<SwapDeadlines>): SwapDeadlines => ({
  ...NO_DEADLINES,
  t_lock: tLock,
  t_final: tLock + 7 * 86_400,
  t_exp: tLock + 37 * 86_400,
  ...more,
});

export const REF = {
  pendingSol: fakeSol('swap-pending-sol'),
  pendingEth: `0x${fakeHex('swap-pending-eth', 32)}`,
  pendingDeny: fakeSol('swap-pending-deny'),
  noticed: fakeSol('swap-noticed'),
  ready: fakeSol('swap-ready'),
  held: fakeSol('swap-held'),
  withheld: fakeSol('swap-withheld'),
  buy: fakeSol('swap-buy'),
  review: `0x${fakeHex('swap-review', 32)}`,
  done1: fakeSol('swap-done-1'),
  done2: fakeSol('swap-done-2'),
  done3: `0x${fakeHex('swap-done-3', 32)}`,
} as const;

export function seedInbox(now: number): InboxItem[] {
  const taker = fakeSol('taker-withheld');
  return [
    {
      id: 'msg-1',
      at: now - 5 * 3_600,
      direction: 'in',
      transport: 'solana',
      type: 'inbox',
      swap_ref: REF.withheld,
      peer: taker,
      text: 'My tab crashed during the swap and I refunded late. Could you release the deposit? Thank you.',
      action: 'release_deposit',
      read: false,
      in_reply_to: null,
    },
    {
      id: 'msg-2',
      at: now - 11 * 60,
      direction: 'in',
      transport: 'tor',
      type: 'inbox',
      swap_ref: REF.held,
      peer: fakeSol('taker-held'),
      text: 'Refunded by mistake, sorry. Please let the deposit go back.',
      action: 'release_deposit',
      read: false,
      in_reply_to: null,
    },
    {
      id: 'msg-3',
      at: now - 26 * 3_600,
      direction: 'in',
      transport: 'solana',
      type: 'inbox',
      swap_ref: null,
      peer: fakeSol('taker-question'),
      text: 'Do you quote above 200 XMR on request?',
      action: null,
      read: true,
      in_reply_to: null,
    },
    {
      id: 'msg-4',
      at: now - 25 * 3_600,
      direction: 'out',
      transport: 'solana',
      type: 'inbox_reply',
      swap_ref: null,
      peer: fakeSol('taker-question'),
      text: 'Yes. Send a quote request from the large-swap page and it is answered within a minute.',
      action: null,
      read: true,
      in_reply_to: 'msg-3',
    },
  ];
}

export function seedSwaps(now: number): SwapDetail[] {
  const inbox = seedInbox(now);
  const base = {
    mode: 0,
    flags: 0,
    deposit_state: 0,
    joint_address: null,
    lock_txid: null,
    lock_confirmations: null,
    lock_state: null,
    sweep_txid: null,
    evidence_published: false,
    intents: [],
    messages: [],
    last_error: null,
    outcome: null,
    needs_review: false,
  } satisfies Partial<SwapDetail>;
  const swaps: SwapDetail[] = [
    {
      ...base,
      chain: 'solana',
      ref: REF.pendingSol,
      market: 'sol',
      direction: 'A',
      state: 'PENDING',
      phase: 'awaiting_approval',
      taker: fakeSol('taker-pending'),
      xmr: xmr(4),
      amount: sol(8.975),
      deposit: '0',
      depth: 10,
      opened_at: now - 22,
      next_deadline: { at: now + 38, label: 'Approval window closes; the taker is refunded in full' },
      actions: ['approve', 'reject'],
      mode: 1,
      deadlines: deadlines(now - 22, { t_pending_deadline: now + 38 }),
    },
    {
      ...base,
      chain: 'ethereum',
      ref: REF.pendingEth,
      market: 'usdc_eth',
      direction: 'A',
      state: 'PENDING',
      phase: 'proof_verified',
      taker: fakeEth('taker-pending-eth'),
      xmr: xmr(12),
      amount: usdc(5_047.16),
      deposit: '0',
      depth: 10,
      opened_at: now - 41,
      next_deadline: { at: now + 79, label: 'Approval window closes; the taker is refunded in full' },
      actions: ['approve', 'reject'],
      deadlines: deadlines(now - 41, { t_pending_deadline: now + 79 }),
    },
    {
      ...base,
      chain: 'solana',
      ref: REF.pendingDeny,
      market: 'sol',
      direction: 'A',
      state: 'PENDING',
      phase: 'awaiting_approval',
      taker: fakeSol('taker-denied'),
      xmr: xmr(48),
      amount: sol(107.7),
      deposit: '0',
      depth: 10,
      opened_at: now - 9,
      next_deadline: { at: now + 51, label: 'Approval window closes; the taker is refunded in full' },
      actions: ['approve', 'reject'],
      mode: 1,
      deadlines: deadlines(now - 9, { t_pending_deadline: now + 51 }),
    },
    {
      ...base,
      chain: 'solana',
      ref: REF.noticed,
      market: 'usdc_sol',
      direction: 'A',
      state: 'NOTICED',
      phase: 'xmr_relayed',
      taker: fakeSol('taker-noticed'),
      xmr: xmr(5),
      amount: usdc(2_092.68),
      deposit: usdc(41.85),
      depth: 10,
      opened_at: now - 14 * 60,
      next_deadline: { at: now + 31 * 60, label: 'Automatic refund cutoff for the taker' },
      actions: ['abort', 'publish-evidence'],
      joint_address: fakeXmrAddr('joint-noticed'),
      lock_txid: fakeHex('lock-noticed', 32),
      lock_confirmations: 6,
      lock_state: 'confirming',
      deadlines: deadlines(now - 14 * 60, {
        t_active: now - 14 * 60,
        t_note_deadline: now - 4 * 60,
        t_notice: now - 13 * 60,
        t_cut: now + 31 * 60,
        t_claim_open: now + 77 * 60,
      }),
      intents: [
        { id: 'int-41', kind: 'xmr_lock', status: 'confirmed', tx: fakeHex('lock-noticed', 32), at: now - 13 * 60 - 20 },
        { id: 'int-42', kind: 'post_notice', status: 'confirmed', tx: fakeSol('sig-notice').slice(0, 44), at: now - 13 * 60 },
      ],
    },
    {
      ...base,
      chain: 'solana',
      ref: REF.ready,
      market: 'usdc_sol',
      direction: 'A',
      state: 'READY',
      phase: 'claiming',
      taker: fakeSol('taker-ready'),
      xmr: xmr(50),
      amount: usdc(21_029.85),
      deposit: usdc(420.6),
      depth: 25,
      opened_at: now - 82 * 60,
      next_deadline: { at: now + 24 * 60, label: 'Claim deadline; a miss is recorded against you' },
      actions: [],
      joint_address: fakeXmrAddr('joint-ready'),
      lock_txid: fakeHex('lock-ready', 32),
      lock_confirmations: 31,
      lock_state: 'confirmed',
      deadlines: deadlines(now - 82 * 60, {
        t_active: now - 82 * 60,
        t_notice: now - 80 * 60,
        t_cut: now - 4 * 60,
        t_ready: now - 6 * 60,
        t_claim_deadline: now + 24 * 60,
      }),
      intents: [{ id: 'int-39', kind: 'claim', status: 'sent', tx: fakeSol('sig-claim'), at: now - 12 }],
    },
    {
      ...base,
      chain: 'solana',
      ref: REF.held,
      market: 'usdc_sol',
      direction: 'A',
      state: 'HOLD',
      phase: 'deposit_held',
      taker: fakeSol('taker-held'),
      xmr: xmr(5),
      amount: usdc(2_090.1),
      deposit: usdc(41.8),
      depth: 10,
      deposit_state: 1,
      opened_at: now - 55 * 60,
      next_deadline: { at: now + 18 * 60, label: 'Hold ends; the deposit returns to the taker unless withheld' },
      actions: ['withhold', 'release'],
      joint_address: fakeXmrAddr('joint-held'),
      lock_txid: fakeHex('lock-held', 32),
      lock_confirmations: 24,
      lock_state: 'confirmed',
      sweep_txid: fakeHex('sweep-held', 32),
      deadlines: deadlines(now - 55 * 60, { t_active: now - 55 * 60, t_notice: now - 53 * 60, t_refund: now - 12 * 60, t_hold: now + 18 * 60 }),
      messages: inbox.filter((m) => m.swap_ref === REF.held),
    },
    {
      ...base,
      chain: 'solana',
      ref: REF.withheld,
      market: 'sol',
      direction: 'A',
      state: 'WITHHELD',
      phase: 'deposit_withheld',
      taker: fakeSol('taker-withheld'),
      xmr: xmr(20),
      amount: sol(44.9),
      deposit: sol(0.898),
      depth: 10,
      deposit_state: 2,
      opened_at: now - 12 * 86_400 - 3_600,
      next_deadline: { at: now + 48 * 86_400, label: '60-day split: half to the taker, half to the treasury' },
      actions: ['release'],
      evidence_published: true,
      joint_address: fakeXmrAddr('joint-withheld'),
      lock_txid: fakeHex('lock-withheld', 32),
      lock_confirmations: 8_640,
      lock_state: 'confirmed',
      sweep_txid: fakeHex('sweep-withheld', 32),
      deadlines: deadlines(now - 12 * 86_400 - 3_600, { t_refund: now - 12 * 86_400, t_hold: now - 12 * 86_400 + 1_800, t_split: now + 48 * 86_400 }),
      messages: inbox.filter((m) => m.swap_ref === REF.withheld),
    },
    {
      ...base,
      chain: 'solana',
      ref: REF.buy,
      market: 'usdc_sol',
      direction: 'B',
      state: 'ACTIVE',
      phase: 'awaiting_taker_xmr',
      taker: fakeSol('taker-buy'),
      xmr: xmr(10),
      amount: usdc(4_082.27),
      deposit: '0',
      depth: 10,
      opened_at: now - 3 * 60,
      next_deadline: { at: now + 7 * 60, label: 'Lock-notice deadline for the taker' },
      actions: ['abort'],
      deadlines: deadlines(now - 3 * 60, { t_active: now - 3 * 60, t_note_deadline: now + 7 * 60 }),
    },
    {
      ...base,
      chain: 'ethereum',
      ref: REF.review,
      market: 'usdc_eth',
      direction: 'A',
      state: 'NOTICED',
      phase: 'needs_review',
      taker: fakeEth('taker-review'),
      xmr: xmr(2),
      amount: usdc(841.2),
      deposit: '0',
      depth: 10,
      opened_at: now - 40 * 60,
      next_deadline: { at: now + 25 * 60, label: 'Automatic refund cutoff for the taker' },
      needs_review: true,
      actions: ['abort', 'publish-evidence'],
      lock_txid: fakeHex('lock-review', 32),
      lock_confirmations: 3,
      lock_state: 'confirming',
      last_error: 'post_notice: the transaction was sent but its receipt is ambiguous; it will not be re-sent',
      deadlines: deadlines(now - 40 * 60, { t_active: now - 39 * 60, t_notice: now - 21 * 60, t_cut: now + 25 * 60 }),
      intents: [{ id: 'int-37', kind: 'post_notice', status: 'needs_review', tx: `0x${fakeHex('tx-review', 32)}`, at: now - 21 * 60 }],
    },
  ];
  const done = [
    { ref: REF.done1, market: 'usdc_sol' as const, chain: 'solana' as const, x: 5, a: usdc(2_088.4), ago: 3 * 3_600, outcome: 'completed' as const },
    { ref: REF.done2, market: 'sol' as const, chain: 'solana' as const, x: 50, a: sol(112.3), ago: 9 * 3_600, outcome: 'completed' as const },
    { ref: REF.done3, market: 'usdc_eth' as const, chain: 'ethereum' as const, x: 5, a: usdc(2_103.0), ago: 20 * 3_600, outcome: 'taker_refunds_noticed' as const },
  ];
  for (const d of done) {
    swaps.push({
      ...base,
      chain: d.chain,
      ref: d.ref,
      market: d.market,
      direction: 'A',
      state: 'DONE',
      phase: 'settled',
      taker: d.chain === 'solana' ? fakeSol(`taker-${d.ref}`) : fakeEth(`taker-${d.ref}`),
      xmr: xmr(d.x),
      amount: d.a,
      deposit: '0',
      depth: d.x >= 50 ? 25 : 10,
      opened_at: now - d.ago,
      next_deadline: null,
      outcome: d.outcome,
      actions: [],
      lock_state: 'confirmed',
      deadlines: deadlines(now - d.ago, { t_settled: now - d.ago + 5_400 }),
    });
  }
  return swaps;
}

export function seedApprovals(now: number): { pending: PendingApproval[]; advance: AdvanceApprovalRecord[] } {
  return {
    pending: [
      {
        chain: 'solana',
        ref: REF.pendingSol,
        market: 'sol',
        direction: 'A',
        taker: fakeSol('taker-pending'),
        xmr: xmr(4),
        amount: sol(8.975),
        deadline: now + 38,
        recommendation: 'approve',
        reasons: ['Within the automatic size limit', 'Exposure after this swap: 71 of 400 XMR'],
        dleq_ok: null,
      },
      {
        chain: 'ethereum',
        ref: REF.pendingEth,
        market: 'usdc_eth',
        direction: 'A',
        taker: fakeEth('taker-pending-eth'),
        xmr: xmr(12),
        amount: usdc(5_047.16),
        deadline: now + 79,
        recommendation: 'approve',
        reasons: ['The taker’s proof verifies', 'Within the automatic size limit'],
        dleq_ok: true,
      },
      {
        chain: 'solana',
        ref: REF.pendingDeny,
        market: 'sol',
        direction: 'A',
        taker: fakeSol('taker-denied'),
        xmr: xmr(48),
        amount: sol(107.7),
        deadline: now + 51,
        recommendation: 'reject',
        reasons: ['Above the automatic size limit of 25 XMR'],
        dleq_ok: null,
      },
    ],
    advance: [
      {
        chain: 'solana',
        id: '18',
        taker: fakeSol('taker-regular'),
        market: 'usdc_sol',
        direction: 'A',
        max_xmr: xmr(100),
        not_before: now - 6 * 86_400,
        expires_at: now + 24 * 86_400,
        epoch: 2,
        active: true,
      },
      {
        chain: 'ethereum',
        id: `0x${fakeHex('approval-eth', 32)}`,
        taker: fakeEth('taker-regular'),
        market: null,
        direction: null,
        max_xmr: xmr(25),
        not_before: now - 40 * 86_400,
        expires_at: now - 10 * 86_400,
        epoch: 2,
        active: false,
      },
    ],
  };
}

export function seedDeposits(now: number): DepositView[] {
  return [
    {
      chain: 'solana',
      ref: REF.held,
      market: 'usdc_sol',
      taker: fakeSol('taker-held'),
      deposit: usdc(41.8),
      state: 'held',
      refunded_at: now - 12 * 60,
      hold_until: now + 18 * 60,
      split_at: now - 12 * 60 + 5_184_000,
      evidence_required: true,
      policy_decision: 'release',
      release_requested: true,
    },
    {
      chain: 'solana',
      ref: REF.withheld,
      market: 'sol',
      taker: fakeSol('taker-withheld'),
      deposit: sol(0.898),
      state: 'withheld',
      refunded_at: now - 12 * 86_400,
      hold_until: now - 12 * 86_400 + 1_800,
      split_at: now + 48 * 86_400,
      evidence_required: true,
      policy_decision: 'none',
      release_requested: true,
    },
  ];
}

export function seedKeys(now: number): EncKeyView[] {
  return [
    { version: 7, public_key: fakeHex('enc-7', 32), current: true, expires_at: null, open_swaps: 6, deleted_at: null },
    { version: 6, public_key: fakeHex('enc-6', 32), current: false, expires_at: now + 5 * 3_600, open_swaps: 1, deleted_at: null },
    { version: 5, public_key: fakeHex('enc-5', 32), current: false, expires_at: now - 6 * 86_400, open_swaps: 1, deleted_at: null },
    { version: 4, public_key: fakeHex('enc-4', 32), current: false, expires_at: now - 13 * 86_400, open_swaps: 0, deleted_at: now - 13 * 86_400 + 600 },
  ];
}

export function seedRefills(now: number): RefillView[] {
  return [
    {
      id: 'refill-31',
      venue: 'wxmr_bridge',
      from: 'usdc_sol',
      to: 'xmr',
      amount_in: usdc(12_400),
      amount_out: null,
      cost_pct: 0.82,
      fees_usd: 101.7,
      state: 'awaiting_approval',
      started_at: now - 4 * 60,
      finished_at: null,
      venue_order_id: null,
      txids: [],
      detail: 'XMR is below its low level (132 of 150). Best net quote: 0.82% against the reference, in 3 pieces.',
    },
    {
      id: 'refill-30',
      venue: 'changenow',
      from: 'usdc_sol',
      to: 'xmr',
      amount_in: usdc(8_000),
      amount_out: null,
      cost_pct: null,
      fees_usd: null,
      state: 'processing',
      started_at: now - 19 * 60,
      finished_at: null,
      venue_order_id: 'cn-7f31',
      txids: [fakeSol('sig-refill-30')],
      detail: 'Deposit received by the service; payout pending.',
    },
    {
      id: 'refill-29',
      venue: 'fixedfloat',
      from: 'sol',
      to: 'xmr',
      amount_in: sol(60),
      amount_out: null,
      cost_pct: null,
      fees_usd: null,
      state: 'held',
      started_at: now - 3 * 3_600,
      finished_at: null,
      venue_order_id: 'ff-22c9',
      txids: [fakeSol('sig-refill-29')],
      detail: 'The deposit arrived outside the quoted limits. Choose at the service: continue at the new rate, or refund minus the network fee.',
    },
    {
      id: 'refill-28',
      venue: 'wxmr_bridge',
      from: 'usdc_sol',
      to: 'xmr',
      amount_in: usdc(20_000),
      amount_out: xmr(48.11),
      cost_pct: 0.79,
      fees_usd: 158.2,
      state: 'done',
      started_at: now - 26 * 3_600,
      finished_at: now - 25 * 3_600,
      venue_order_id: null,
      txids: [fakeSol('sig-refill-28a'), fakeHex('xmr-refill-28', 32)],
      detail: null,
    },
    {
      id: 'refill-27',
      venue: 'manual',
      from: 'usdc_sol',
      to: 'xmr',
      amount_in: usdc(4_100),
      amount_out: xmr(9.9),
      cost_pct: 0.41,
      fees_usd: 16.8,
      state: 'done',
      started_at: now - 3 * 86_400,
      finished_at: now - 3 * 86_400,
      venue_order_id: null,
      txids: [],
      detail: 'OTC with a known counterparty',
    },
  ];
}

export function seedAlerts(now: number): Alert[] {
  return [
    {
      id: '9',
      at: now - 21 * 60,
      level: 'critical',
      kind: 'needs_review',
      message: 'A lock notice on Ethereum was sent but its receipt is ambiguous. It will not be re-sent; check the swap.',
      swap_ref: REF.review,
      acknowledged: false,
    },
    { id: '8', at: now - 4 * 60, level: 'warning', kind: 'refill_level', message: 'XMR is below its low level: 132 of 150 XMR. A refill is waiting for approval.', acknowledged: false },
    { id: '7', at: now - 3 * 3_600, level: 'warning', kind: 'venue_held', message: 'FixedFloat holds refill-29 in its emergency state. It still counts against the in-transit cap.', acknowledged: false },
    { id: '6', at: now - 30 * 3_600, level: 'info', kind: 'key_rotated', message: 'Encryption key rotated to version 7.', acknowledged: true },
  ];
}

export function seedInventory(): InventoryResponse {
  const outputs: InventoryResponse['outputs'] = [];
  for (let i = 0; i < 20; i++) {
    outputs.push({
      key_image: fakeHex(`ki-5-${i}`, 32),
      amount: xmr(5.02),
      unlocked: i < 15,
      blocks_to_unlock: i < 15 ? 0 : 10 - (i - 14),
      frozen: i < 2,
      reserved_for: i === 0 ? REF.noticed : i === 1 ? REF.held : null,
    });
  }
  for (let i = 0; i < 5; i++) {
    outputs.push({
      key_image: fakeHex(`ki-50-${i}`, 32),
      amount: xmr(50.2),
      unlocked: i < 4,
      blocks_to_unlock: i < 4 ? 0 : 7,
      frozen: i === 0,
      reserved_for: i === 0 ? REF.ready : null,
    });
  }
  return {
    xmr: { balance: xmr(351.4), unlocked: xmr(276.1), reserve: xmr(50), in_flight: xmr(71) },
    ladder: [
      { size_xmr: xmr(5), target_count: 20, unlocked_count: 15, locked_count: 5 },
      { size_xmr: xmr(50), target_count: 6, unlocked_count: 4, locked_count: 1 },
    ],
    outputs,
    capacity_xmr: xmr(13 * 5.02 + 3 * 50.2),
    paying: [
      { asset: 'sol', balance: sol(412.6), cap: sol(300), escrowed: '0' },
      { asset: 'eth', balance: eth(3.2), cap: null, escrowed: '0' },
      { asset: 'usdc_sol', balance: usdc(96_420.55), cap: usdc(60_000), escrowed: usdc(4_082.27) },
      { asset: 'usdc_eth', balance: usdc(18_300), cap: null, escrowed: '0' },
    ],
  };
}
