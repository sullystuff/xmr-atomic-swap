/** Display helpers. Amounts are bigint atomic units everywhere; nothing here uses floats for money. */
import { type ChainName, MARKET_DECIMALS, type Market, PICONERO_PER_XMR } from '@xmrswap/protocol';

export const ASSET_LABEL: Readonly<Record<Market, string>> = { sol: 'SOL', usdc_sol: 'USDC', eth: 'ETH', usdc_eth: 'USDC' };
export const MARKET_LABEL: Readonly<Record<Market, string>> = { sol: 'SOL on Solana', usdc_sol: 'USDC on Solana', eth: 'ETH on Ethereum', usdc_eth: 'USDC on Ethereum' };
export const CHAIN_LABEL: Readonly<Record<ChainName, string>> = { solana: 'Solana', ethereum: 'Ethereum' };

/** `units` as a decimal string with at most `maxFrac` fractional digits (truncated, never rounded up), trailing zeros dropped down to `minFrac`. */
export function formatUnits(units: bigint, decimals: number, maxFrac = decimals, minFrac = 0): string {
  const neg = units < 0n;
  const abs = neg ? -units : units;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  let frac = (abs % base).toString().padStart(decimals, '0').slice(0, Math.min(maxFrac, decimals));
  while (frac.length > minFrac && frac.endsWith('0')) frac = frac.slice(0, -1);
  const w = whole.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${neg ? '-' : ''}${w}${frac ? `.${frac}` : ''}`;
}

/** Parse a decimal string into atomic units. `null` for anything that is not a plain non-negative decimal within `decimals`. */
export function parseUnits(text: string, decimals: number): bigint | null {
  const t = text.trim().replace(/,/g, '');
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return null;
  const [w = '0', f = ''] = t.split('.');
  if (f.length > decimals) return null;
  return BigInt(w || '0') * 10n ** BigInt(decimals) + BigInt((f + '0'.repeat(decimals)).slice(0, decimals) || '0');
}

export const formatXmrAmount = (pico: bigint, maxFrac = 6): string => formatUnits(pico, 12, maxFrac, 2);
export const parseXmr = (text: string): bigint | null => parseUnits(text, 12);
export const formatAsset = (units: bigint, market: Market, maxFrac?: number): string =>
  formatUnits(units, MARKET_DECIMALS[market], maxFrac ?? (market === 'sol' || market === 'eth' ? 6 : 2), market === 'sol' || market === 'eth' ? 2 : 2);
/** A price in asset base units per 1 XMR, as "<n> SOL". */
export const formatPrice = (price: bigint, market: Market): string => `${formatAsset(price, market, market === 'eth' ? 6 : 4)} ${ASSET_LABEL[market]}`;

/** What `xmr` piconero costs at `price` (base units per XMR), rounded up: display only; the core does the real arithmetic. */
export const xmrAt = (payUnits: bigint, price: bigint): bigint => (price === 0n ? 0n : (payUnits * PICONERO_PER_XMR) / price);

/** "1 h 41 min", "4 min 05 s", "45 s". Negative values read as "0 s". */
export function formatDuration(secs: number | bigint): string {
  let s = Math.max(0, Number(secs));
  const d = Math.floor(s / 86_400);
  s -= d * 86_400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return h ? `${d} d ${h} h` : `${d} d`;
  if (h > 0) return m ? `${h} h ${m} min` : `${h} h`;
  if (m > 0) return s ? `${m} min ${String(s).padStart(2, '0')} s` : `${m} min`;
  return `${s} s`;
}

/** A countdown: "1:41:07" or "04:05". */
export function formatClock(secs: number | bigint): string {
  const total = Math.max(0, Number(secs));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** A chain time (seconds) as a local wall-clock time, with the date when it is not today. */
export function formatTime(chainSecs: bigint | number, nowSecs?: bigint | number): string {
  const d = new Date(Number(chainSecs) * 1000);
  const ref = new Date(nowSecs === undefined ? Date.now() : Number(nowSecs) * 1000);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const sameDay = d.getFullYear() === ref.getFullYear() && d.getMonth() === ref.getMonth() && d.getDate() === ref.getDate();
  return sameDay ? time : `${d.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}

export const formatPercent = (ratio: number | null, digits = 0): string => (ratio === null ? 'no history' : `${(ratio * 100).toFixed(digits)}%`);
export const bpsPercent = (bps: number): string => `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

/** A long identifier shortened for display; the full value goes in `title` and is copyable. */
export const shorten = (s: string, head = 6, tail = 4): string => (s.length <= head + tail + 1 ? s : `${s.slice(0, head)}…${s.slice(-tail)}`);

const XMR_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{95}$|^[1-9A-HJ-NP-Za-km-z]{106}$/;
/** Shape check only (length and alphabet). The sweep itself refuses an address the core cannot parse. */
export const looksLikeXmrAddress = (a: string): boolean => XMR_ADDRESS.test(a.trim());

export const bigJson = (v: unknown): string => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? `${x}n` : x));
