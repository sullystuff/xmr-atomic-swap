/**
 * Display helpers. Amounts arrive as decimal strings in atomic units (SPEC 1.5) and are handled
 * as bigint; they are never converted to `number`.
 */
import type { AssetId } from '@xmrswap/protocol/daemon-api';
import type { Market } from '@xmrswap/protocol';

export const ASSET_DECIMALS: Readonly<Record<AssetId, number>> = { xmr: 12, sol: 9, eth: 18, usdc_sol: 6, usdc_eth: 6 };
export const ASSET_LABEL: Readonly<Record<AssetId, string>> = {
  xmr: 'XMR',
  sol: 'SOL',
  eth: 'ETH',
  usdc_sol: 'USDC (Solana)',
  usdc_eth: 'USDC (Ethereum)',
};
export const ASSET_UNIT: Readonly<Record<AssetId, string>> = { xmr: 'XMR', sol: 'SOL', eth: 'ETH', usdc_sol: 'USDC', usdc_eth: 'USDC' };
export const MARKET_LABEL: Readonly<Record<Market, string>> = { usdc_sol: 'USDC-SOL', sol: 'SOL', usdc_eth: 'USDC-ETH', eth: 'ETH' };
/** DESIGN's market order. */
export const MARKET_ORDER: readonly Market[] = ['usdc_sol', 'sol', 'usdc_eth', 'eth'];

const GROUP = /\B(?=(\d{3})+(?!\d))/g;

/** Atomic units to a decimal string, with at most `maxFrac` fraction digits (truncated, never rounded up). */
export function fmtUnits(amount: string | bigint, decimals: number, maxFrac = decimals, group = true): string {
  let v: bigint;
  try {
    v = typeof amount === 'bigint' ? amount : BigInt(amount);
  } catch {
    return String(amount);
  }
  const neg = v < 0n;
  if (neg) v = -v;
  const base = 10n ** BigInt(decimals);
  const whole = (v / base).toString();
  let frac = (v % base).toString().padStart(decimals, '0').slice(0, Math.max(0, maxFrac));
  frac = frac.replace(/0+$/, '');
  const w = group ? whole.replace(GROUP, ',') : whole;
  return `${neg ? '-' : ''}${w}${frac ? `.${frac}` : ''}`;
}

/** A decimal string such as "0.5" to atomic units. Throws on anything that is not a plain decimal. */
export function parseUnits(text: string, decimals: number): bigint {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d+)?$/.test(t)) throw new Error(`not a decimal amount: ${text}`);
  const [whole = '0', frac = ''] = t.split('.');
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(frac.padEnd(decimals, '0') || '0');
}

export const fmtXmr = (piconero: string | bigint, maxFrac = 4): string => `${fmtUnits(piconero, 12, maxFrac)} XMR`;
export const fmtAsset = (asset: AssetId, amount: string | bigint, maxFrac?: number): string =>
  `${fmtUnits(amount, ASSET_DECIMALS[asset], maxFrac ?? (asset.startsWith('usdc') ? 2 : 6))} ${ASSET_UNIT[asset]}`;
export const fmtMarketAmount = (market: Market, amount: string | bigint, maxFrac?: number): string => fmtAsset(market, amount, maxFrac);
export const fmtSol = (lamports: string | bigint, maxFrac = 9): string => `${fmtUnits(lamports, 9, maxFrac)} SOL`;

export function fmtUsd(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `$${v.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}
export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return 'n/a';
  return `${v.toFixed(digits)}%`;
}
/** A rate between 0 and 1 as a percentage. */
export const fmtRate = (v: number | null | undefined, digits = 1): string => (v === null || v === undefined ? 'n/a' : fmtPct(v * 100, digits));
export const fmtInt = (v: number): string => Math.round(v).toLocaleString('en-US');

/** `1d 2h`, `3h 04m`, `12m 05s`, `45s`. Negative durations render as "0s". */
export function fmtDuration(secs: number): string {
  let s = Math.max(0, Math.floor(secs));
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3_600);
  s -= h * 3_600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  const two = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${two(m)}m`;
  if (m > 0) return `${m}m ${two(s)}s`;
  return `${s}s`;
}

/** UTC, to the second: `2026-11-21 14:03:22Z`. Deadlines are chain time, so no local zone. */
export function fmtTime(ts: number | null | undefined): string {
  if (ts === null || ts === undefined) return 'n/a';
  return `${new Date(ts * 1000).toISOString().slice(0, 19).replace('T', ' ')}Z`;
}

/** Shorten an address or hash for a table cell; the full value goes in `title`. */
export function shortId(id: string | null | undefined, head = 6, tail = 4): string {
  if (!id) return 'n/a';
  return id.length <= head + tail + 1 ? id : `${id.slice(0, head)}…${id.slice(-tail)}`;
}

export const marketAsset = (m: Market): Exclude<AssetId, 'xmr'> => m;
